// Background tracker for Meme Radar.
// Runs on a schedule in GitHub Actions. It scores the same coins the page scans, using the
// scoring code lifted straight out of index.html (the blocks between the CORE markers), then
// records every buy signal and follows it until it exits. Output goes to data/signals.json.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { QUICK, STEADY, RECOVERY, FRESH, ADAPTIVE_START, ADAPTIVE_VERSION, describe, freshWallet, stepWallet } from "./strategy.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.dexscreener.com";
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens/";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const HZ = { h1: 3600e3, h6: 6 * 3600e3, h24: 24 * 3600e3 };
const DEFAULT_WATCH = [
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
];

async function realGetJSON(url) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "meme-radar-tracker" }, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const SKIP = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => (typeof x === "number" && isFinite(x)) ? x : 0;
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } }
// For the records that must never be silently reset: a missing file means "start fresh",
// but a file that exists and cannot be read stops the run before anything is overwritten.
function readState(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, "utf8");
  try { return JSON.parse(text); } catch (e) { throw new Error("Saved file " + path.basename(file) + " is unreadable, stopping so it is not overwritten"); }
}
function writeJSON(file, obj) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); }

export async function run({ root, getJSON = realGetJSON, now = Date.now(), pause = 300 } = {}) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const coreSrc = [...html.matchAll(/\/\*CORE>\*\/([\s\S]*?)\/\*<CORE\*\//g)].map(m => m[1]).join("\n");
  if (!coreSrc) throw new Error("No scoring code found in index.html");
  const core = new Function(coreSrc + "\nreturn {analyse, parseReport, ADDR_RE, BUY_AT};")();
  const { analyse, parseReport, ADDR_RE, BUY_AT } = core;

  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const state = readState(path.join(dataDir, "signals.json"), {});
  const signals = Array.isArray(state.signals) ? state.signals : [];
  const cache = readJSON(path.join(dataDir, "cache.json"), {});
  const peak = cache.peak || {}, rcCache = cache.rc || {};
  const errors = [];

  // 1. Which coins to look at
  const wl = readJSON(path.join(root, "watchlist.json"), null);
  const watch = (Array.isArray(wl) ? wl : DEFAULT_WATCH).filter(a => ADDR_RE.test(a));
  // The coin lists change slowly, so they are refreshed about every 5 minutes and reused in between.
  // Prices and verdicts are checked on every run.
  const boosts = new Map(); let trend = [], fresh = [];
  const lists = cache.lists || { trend: {}, vol: {} };
  const refresh = !(cache.disc && now - cache.disc.at < 4.5 * 60e3);
  const runNo = (cache.run || 0) + (refresh ? 1 : 0);
  let disc = cache.disc;
  if (refresh) {
    const res = await Promise.allSettled(["/token-boosts/top/v1", "/token-boosts/latest/v1", "/token-profiles/latest/v1"].map(e => getJSON(API + e)));
    res.forEach(r => {
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) return;
      r.value.forEach(x => {
        if (!x || x.chainId !== "solana" || !ADDR_RE.test(x.tokenAddress || "")) return;
        if (x.totalAmount) boosts.set(x.tokenAddress, Math.max(boosts.get(x.tokenAddress) || 0, num(x.totalAmount)));
        if (!trend.includes(x.tokenAddress)) trend.push(x.tokenAddress);
      });
    });
    if (res.every(r => r.status === "rejected")) { errors.push("trending list failed"); if (disc) { trend = disc.trend || []; (disc.boosts || []).forEach(([a, v]) => boosts.set(a, v)); } }
    // GeckoTerminal allows only a few calls a minute from here, so each refresh asks for the new pairs
    // plus one page of each longer list, and earlier pages are remembered for three hours.
    const gtPage = async (pq, p) => {
      const j = await getJSON(GT + pq + (pq.includes("?") ? "&" : "?") + "page=" + p), out = [];
      (j.data || []).forEach(d => { const a = String(((((d || {}).relationships || {}).base_token || {}).data || {}).id || "").replace(/^solana_/, ""); if (ADDR_RE.test(a) && !SKIP.has(a) && !out.includes(a)) out.push(a); });
      return out;
    };
    try { fresh = await gtPage("/new_pools", 1); } catch (e) { errors.push("new pairs list failed (" + e.message + ")"); fresh = (disc && disc.fresh) || []; }
    await sleep(pause * 8);
    try { const p = (runNo % 3) + 1; lists.trend[p] = { at: now, ids: await gtPage("/trending_pools", p) }; } catch (e) { errors.push("trending pools page failed (" + e.message + ")"); }
    await sleep(pause * 8);
    try { const p = (runNo % 4) + 1; lists.vol[p] = { at: now, ids: await gtPage("/pools?sort=h24_volume_usd_desc", p) }; } catch (e) { errors.push("top volume page failed (" + e.message + ")"); }
    disc = { at: now, trend: trend.slice(0, 40), boosts: [...boosts].filter(([a]) => trend.slice(0, 40).includes(a)), fresh: fresh.slice(0, 20) };
  } else {
    trend = disc.trend || []; fresh = disc.fresh || []; (disc.boosts || []).forEach(([a, v]) => boosts.set(a, v));
  }
  const pool = set => [...new Set(Object.values(set).filter(e => e && now - e.at < 3 * 3600e3).flatMap(e => e.ids))];
  const gtTrend = pool(lists.trend), vol = pool(lists.vol);
  // Where each coin came from: b = DexScreener boosted or promoted, t = GeckoTerminal trending, v = top volume, n = new pair, w = watchlist.
  const srcSets = { b: new Set(trend.slice(0, 30)), t: new Set(gtTrend), v: new Set(vol), n: new Set(fresh), w: new Set(watch) };
  const srcOf = a => Object.keys(srcSets).filter(k => srcSets[k].has(a)).join("");
  const openIds = signals.filter(r => r.st === "open").map(r => r.a);
  // Young coins are followed for 48 hours after they are first seen, even once they drop off the lists,
  // so we find out which ones were pulled, which dumped and which survived.
  const follow = cache.follow || {};
  Object.keys(follow).forEach(a => { if (now - follow[a] > 48 * 3600e3) delete follow[a]; });
  const followIds = Object.keys(follow).sort((p, q) => follow[q] - follow[p]).slice(0, 200);
  const heldEarly = [...new Set(["wallet.json", "wallet-b.json", "wallet-c.json", "wallet-d.json", "wallet-e.json"].flatMap(f => Object.keys((readJSON(path.join(dataDir, f), {}) || {}).pos || {})))];
  const ids = [...new Set([...watch, ...openIds, ...heldEarly, ...trend.slice(0, 30), ...gtTrend.slice(0, 60), ...vol.slice(0, 70), ...fresh.slice(0, 20), ...followIds])].slice(0, 420);

  // 2. Prices
  const tokens = new Map(); let priceOk = false, solPx = 0, solLiq = 0;
  for (let i = 0; i < ids.length; i += 30) {
    try {
      const list = await getJSON(API + "/tokens/v1/solana/" + ids.slice(i, i + 30).join(","));
      priceOk = true;
      const by = new Map();
      (Array.isArray(list) ? list : []).forEach(p => { const a = p && p.baseToken && p.baseToken.address; if (!a) return; if (!by.has(a)) by.set(a, []); by.get(a).push(p); });
      by.forEach((pairs, a) => {
        pairs.sort((x, y) => num(y.liquidity && y.liquidity.usd) - num(x.liquidity && x.liquidity.usd));
        const totalLiq = pairs.reduce((s, p) => s + num(p.liquidity && p.liquidity.usd), 0);
        tokens.set(a, { addr: a, pair: pairs[0], totalLiq, nPairs: pairs.length });
        peak[a] = Math.max(num(peak[a]), totalLiq);
        pairs.forEach(p => { const l = num(p.liquidity && p.liquidity.usd), k = Number(p.priceUsd) / Number(p.priceNative);
          if (p.quoteToken && p.quoteToken.address === SOL_MINT && isFinite(k) && k > 1 && l > solLiq) { solLiq = l; solPx = k; } });
      });
    } catch (e) { errors.push("prices failed for a batch"); }
  }

  const meta = { lastRun: now, scanned: ids.length, priced: tokens.size, errors };
  if (!priceOk) {
    // Nothing reliable to act on. Record the failed run and leave every signal untouched.
    meta.lastGood = (state.meta && (state.meta.lastGood || state.meta.lastRun)) || 0;
    writeJSON(path.join(dataDir, "signals.json"), { meta, signals });
    writeJSON(path.join(dataDir, "cache.json"), Object.assign({}, cache, { peak, rc: rcCache, lists, disc, run: runNo, follow }));
    return { meta, signals };
  }
  meta.lastGood = now;

  // 3. First pass on market data alone, to decide which coins are worth an on-chain lookup
  const histOf = a => ({ pts: [], peakLiq: num(peak[a]) });
  //    Coins with an open signal or held by a wallet always get one; after that, the 60 strongest
  //    scores with tradeable liquidity, so their holder figures are on record for later analysis.
  const heldIds = heldEarly;
  const need = [], cand = [], young = [];
  tokens.forEach((t, a) => {
    const x = analyse(t, histOf(a), undefined, boosts.get(a) || 0, null, null);
    // Start following young coins with real liquidity the first time they are seen.
    if (x.ageH != null && x.ageH < 24 && num(x.liq) >= 30000 && !follow[a]) follow[a] = now;
    const h1 = num(((t.pair || {}).priceChange || {}).h1);
    if (openIds.includes(a) || heldIds.includes(a)) need.push(a);
    else if (x.ageH != null && x.ageH < 24 && num(x.liq) >= 50000 && h1 >= 10) young.push([a, h1]);
    else if (x.score >= 20 && x.liq >= 10000) cand.push([a, x.score]);
  });
  // Young coins that are pumping get their on-chain check early, so the fresh-launch wallet can act on them.
  young.sort((p, q) => q[1] - p[1]).slice(0, 20).forEach(k => need.push(k[0]));
  cand.sort((p, q) => q[1] - p[1]).slice(0, 60).forEach(k => need.push(k[0]));
  let rcFails = 0, rcDone = 0;
  for (const a of need) {
    const c = rcCache[a];
    if (c && now - c.at < 25 * 60e3) continue;
    if (rcFails >= 3 || rcDone >= 25) break;
    rcDone++;
    try {
      let j;
      try { j = await getJSON(RUGCHECK + a + "/report"); } catch (e) { j = await getJSON(RUGCHECK + a + "/report/summary"); }
      rcCache[a] = Object.assign({ ok: true, at: now }, parseReport(j));
      rcFails = 0;
    } catch (e) { rcCache[a] = { ok: false, at: now }; rcFails++; }
    await sleep(pause);
  }
  if (rcFails >= 3) errors.push("on-chain checks unavailable");
  // Holder counts over time, so growth per hour can be worked out for each coin.
  const hh = cache.hh || {};
  need.forEach(a => {
    const rc = rcCache[a], tot = rc && rc.ok && rc.hold ? num(rc.hold.total) : 0; if (!tot) return;
    const arr = hh[a] || (hh[a] = []), last = arr[arr.length - 1];
    if (!last || rc.at > last[0]) arr.push([rc.at, tot]);
    while (arr.length && now - arr[0][0] > 3 * 3600e3) arr.shift();
  });
  const hgOf = a => {
    const arr = hh[a]; if (!arr || arr.length < 2) return null;
    const cur = arr[arr.length - 1]; let best = null;
    for (const smp of arr) { const age = cur[0] - smp[0]; if (age >= 40 * 60e3 && age <= 100 * 60e3 && (!best || Math.abs(age - 3600e3) < Math.abs(cur[0] - best[0] - 3600e3))) best = smp; }
    return best && best[1] > 0 ? (cur[1] / best[1] - 1) * 100 * (3600e3 / (cur[0] - best[0])) : null;
  };

  // 4. Final verdicts
  const A = new Map();
  tokens.forEach((t, a) => {
    const rc = need.includes(a) ? (rcCache[a] || { ok: false, at: now }) : undefined;
    A.set(a, analyse(t, histOf(a), rc, boosts.get(a) || 0, null, null));
  });

  // 4b. Who is trading: distinct buyers and sellers over the last 15 minutes, from recent trades.
  //     GeckoTerminal's limits allow only a couple of these per run, so held coins and current buys come first.
  const flow = cache.flow || {};
  let gtWait = num(cache.gtWait);
  if (now >= gtWait) {
    const order = [...new Set([...heldIds, ...[...A].filter(([, x]) => x.signal === "buy").map(([a]) => a), ...need])]
      .filter(a => tokens.has(a) && tokens.get(a).pair.pairAddress && !(flow[a] && now - flow[a].at < 10 * 60e3));
    for (const a of order.slice(0, 2)) {
      try {
        const j = await getJSON(GT + "/pools/" + encodeURIComponent(tokens.get(a).pair.pairAddress) + "/trades");
        const list = ((j || {}).data || []).map(d => { const x = (d || {}).attributes || {}; return { t: Date.parse(x.block_timestamp), kind: x.kind, usd: Number(x.volume_in_usd) || 0, w: x.tx_from_address || "" }; })
          .filter(x => isFinite(x.t) && now - x.t <= 15 * 60e3 && (x.kind === "buy" || x.kind === "sell"));
        const buys = list.filter(x => x.kind === "buy"), sells = list.filter(x => x.kind === "sell"), sum = l => l.reduce((s, x) => s + x.usd, 0);
        const byW = new Map(); list.forEach(x => byW.set(x.w, (byW.get(x.w) || 0) + x.usd));
        const tot = sum(list), top = tot > 0 ? Math.max(0, ...byW.values()) / tot : 0;
        flow[a] = { at: now, ub: new Set(buys.map(x => x.w)).size, us: new Set(sells.map(x => x.w)).size, nb: buys.length, ns: sells.length, bu: Math.round(sum(buys)), su: Math.round(sum(sells)), top: Math.round(top * 1000) / 1000 };
      } catch (e) {
        if (/429/.test(e.message)) { gtWait = now + 5 * 60e3; errors.push("trade lookups paused for 5 minutes (rate limit)"); break; }
        flow[a] = { at: now, err: 1 };
      }
      await sleep(pause * 4);
    }
  }

  // 5. Follow open signals, close the ones that hit an exit
  signals.forEach(r => {
    if (!r.r) r.r = {};
    const x = A.get(r.a);
    for (const k in HZ) {
      if (r.r[k] !== undefined || now < r.t + HZ[k]) continue;
      if (x && x.px > 0) r.r[k] = x.px / r.px - 1;
      else if (now > r.t + HZ[k] + 2 * 3600e3) r.r[k] = null;
    }
    if (r.st !== "open") return;
    if (x && x.px > 0) {
      const gap = !!r.lastT && now - r.lastT > 40 * 60e3;
      if (x.px > r.hi) r.hi = x.px;
      if (x.px < r.lo) r.lo = x.px;
      r.last = x.px; r.lastT = now; r.miss = 0; r.now = x.signal;
      let why = x.signal === "sell" ? "Sell signal" : x.signal === "rug" ? "Rug risk" : x.signal === "avoid" ? "Liquidity fell under $10k" : "";
      if (!why && x.px <= r.px * 0.75) why = "Stop-loss rule, 25% down";
      if (!why && r.hi >= r.px * 1.3 && x.px <= r.hi * 0.65) why = "Trailing stop rule";
      if (why) { r.st = "closed"; r.x = { t: now, px: x.px, why, gap }; }
    } else {
      r.miss = (r.miss || 0) + 1;
      if (r.miss >= 20) { r.st = "closed"; r.x = { t: now, px: r.last, why: "No longer listed", gap: false, stale: true }; }
    }
  });

  // 6. Log new buy signals
  const buysNow = [], openedNow = [];
  A.forEach((x, a) => {
    if (x.signal !== "buy" || x.onchain === "pending" || !(x.px > 0)) return;
    const t = tokens.get(a), sym = (t.pair.baseToken || {}).symbol || "?";
    buysNow.push(sym);
    if (signals.some(r => r.a === a && (r.st === "open" || (r.x && now - r.x.t < 3600e3)))) return;
    openedNow.push(a);
    signals.unshift({ a, sym, pool: t.pair.pairAddress || "", t: now, px: x.px, score: x.score, conf: x.conf, pass: x.passN, of: x.checks.length,
      failed: x.checks.filter(c => c.state === "fail").map(c => c.name), r: {}, st: "open", hi: x.px, lo: x.px, last: x.px, lastT: now, now: "buy" });
  });
  meta.buysNow = buysNow;
  meta.open = signals.filter(r => r.st === "open").length;

  const cfg = Object.assign({ startSol: 10, feePct: 1, resetId: 0 }, (readJSON(path.join(root, "config.json"), {}).wallet) || {});
  if (!(solPx > 0)) errors.push("no SOL price, auto wallets not updated");

  // 6c. Rule-driven wallets, stepped by the shared engine in strategy.mjs.
  //     "wallet-b" keeps the fixed tighter rules. "wallet-c" uses whatever rules the daily tuning last settled on.
  {
    const obs = new Map();
    A.forEach((x, a) => {
      const p = tokens.get(a).pair, ch = p.priceChange || {}, tx = (p.txns || {}).h1 || {}, v = p.volume || {}, b1 = num(tx.buys), s1 = num(tx.sells);
      // No liquidity figure this check: a data gap, so the wallets skip the coin rather than read it as a rug.
      if (!(p.liquidity && typeof p.liquidity.usd === "number")) return;
      obs.set(a, { px: x.px, liq: num(x.liq), score: x.score, rug: x.rug, fails: x.checks.slice(0, 10).filter(k => k.state === "fail").length, oc: x.onchain[0],
        h1: num(ch.h1), m5: num(ch.m5), h24: num(ch.h24), age: x.ageH == null ? null : x.ageH, src: srcOf(a), hg: hgOf(a), bp: b1 + s1 >= 20 ? b1 / (b1 + s1) : null, acc: num(v.h6) > 0 ? num(v.h1) / (num(v.h6) / 6) : null });
    });
    const fee = Math.max(0, Math.min(20, Number(cfg.feePct) || 0)) / 100;
    const tuning = readJSON(path.join(dataDir, "tuning.json"), null);
    const adaptive = Object.assign({}, ADAPTIVE_START, tuning && tuning.ver === ADAPTIVE_VERSION && tuning.current ? tuning.current : {});
    const info = a => { const x = A.get(a), t = tokens.get(a); return { sym: (t && (t.pair.baseToken || {}).symbol) || "?", checks: x ? x.passN + "/" + x.checks.length : "", conf: x ? x.conf : "" }; };
    const OLD_NAMES = { "wallet.json": "Original rules", "wallet-b.json": "Tighter rules", "wallet-c.json": "Adaptive rules" };
    const ruleWallet = (file, name, P, idKey, metaKey, extra) => {
      const rid = num(cfg[idKey]);
      let R = readState(path.join(dataDir, file), null);
      if (!R || R.resetId !== rid || !R.pos) {
        // A reset keeps the old wallet on file and carries a one-line summary of how it ended.
        let prev = null;
        if (R && R.pos && R.start > 0) {
          fs.mkdirSync(path.join(dataDir, "archive"), { recursive: true });
          writeJSON(path.join(dataDir, "archive", file.replace(".json", "") + "-round" + num(R.resetId) + ".json"), R);
          const sells = (R.hist || []).filter(h => h.side === "sell");
          prev = { name: R.name || OLD_NAMES[file] || "Earlier rules", start: R.start, equity: num(R.equity) || R.cash, started: R.started, ended: now, trades: sells.length, wins: sells.filter(h => h.pnl > 0).length };
        }
        R = freshWallet(cfg.startSol, now, { resetId: rid, prev });
      }
      R.name = name;
      R.cfg = { feePct: cfg.feePct }; R.params = P; R.about = describe(P); Object.assign(R, extra || {});
      if (!(solPx > 0)) return;
      const equity = stepWallet(R, obs, P, { now, solPx, fee, info, verdictOf: a => (A.get(a) || {}).signal });
      R.solPx = solPx;
      const last = R.eq[R.eq.length - 1];
      if (!last || now - last.t >= 4.5 * 60e3) R.eq.push({ t: now, v: Math.round(equity * 1e4) / 1e4 });
      if (R.eq.length > 2500) R.eq = R.eq.filter((_, k) => k % 2 === 0 || k > R.eq.length - 400);
      R.hist = R.hist.slice(0, 800);
      writeJSON(path.join(dataDir, file), R);
      meta[metaKey] = Math.round(equity * 1e4) / 1e4;
    };
    ruleWallet("wallet.json", "Quick profit", QUICK, "resetId", "wallet");
    ruleWallet("wallet-b.json", "Established coins", STEADY, "resetIdB", "walletB");
    ruleWallet("wallet-d.json", "Recovery", RECOVERY, "resetIdD", "walletD");
    ruleWallet("wallet-e.json", "Fresh launches", FRESH, "resetIdE", "walletE");
    ruleWallet("wallet-c.json", "Adaptive", adaptive, "resetIdC", "walletC", { tuned: tuning ? { since: tuning.since, changes: (tuning.history || []).length, ready: !!tuning.ready } : null });
  }

  // 6d. Launch outcomes: every followed young coin, from first sight until it is pulled, dumps, stops
  //     trading or reaches 48 hours. A rug score is recorded the first time one comes back.
  try {
    const lf = path.join(dataDir, "launches.json"), L = readJSON(lf, { list: [] }), byA = new Map((L.list || []).map(r => [r.a, r]));
    Object.keys(follow).forEach(a => {
      const t = tokens.get(a), x = A.get(a); let r = byA.get(a);
      if (!r) {
        if (!(t && x && x.px > 0)) return;
        r = { a, sym: (t.pair.baseToken || {}).symbol || "?", name: (t.pair.baseToken || {}).name || "", t0: now, px0: x.px, liq0: Math.round(num(x.liq)), age0: x.ageH == null ? null : Math.round(x.ageH * 10) / 10,
          h1_0: Math.round(num((t.pair.priceChange || {}).h1)), score0: x.score, rug0: null, hi: x.px, hiT: now, lo: x.px, liqMax: Math.round(num(x.liq)), last: x.px, lastT: now, liqLast: Math.round(num(x.liq)), out: null };
        byA.set(a, r);
      }
      const rc = rcCache[a];
      if (r.rug0 == null && rc && rc.ok && x) r.rug0 = x.rug;
      // A missing liquidity figure is a data gap, not a pulled pool, so that check is skipped.
      const liqKnown = !!(t && t.pair && t.pair.liquidity && typeof t.pair.liquidity.usd === "number");
      if (t && x && x.px > 0) {
        const liq = liqKnown ? Math.round(num(x.liq)) : r.liqLast;
        if (x.px > r.hi) { r.hi = x.px; r.hiT = now; } if (x.px < r.lo) r.lo = x.px;
        r.last = x.px; r.lastT = now; r.liqLast = liq; if (liq > r.liqMax) r.liqMax = liq; r.rugNow = x.rug;
        if (!r.out) {
          if (liq < Math.max(5000, r.liqMax * 0.2)) { r.out = "pulled"; r.outT = now; }
          else if (x.px <= r.hi * 0.2) { r.out = "dumped"; r.outT = now; }
        }
      } else if (!r.out && now - r.lastT > 30 * 60e3) { r.out = "gone"; r.outT = now; }
      if (!r.out && now - r.t0 >= 48 * 3600e3) { r.out = "survived"; r.outT = now; }
    });
    const list = [...byA.values()].filter(r => now - r.t0 < 7 * 86400e3).sort((p, q) => q.t0 - p.t0).slice(0, 1500);
    writeJSON(lf, { t: now, following: Object.keys(follow).length, list });
    meta.launches = list.length;
  } catch (e) { errors.push("launch outcomes not saved"); }

  // 6b. Keep a record of each coin's inputs and verdict, so rule changes can later be replayed against
  //     exactly what the tracker saw. Every coin about every 10 minutes; coins near a buy, with an open
  //     signal or held by a wallet on every run. One compressed file per hour.
  let snapAt = num(cache.lastSnap);
  try {
    const full = now - snapAt >= 9 * 60e3;
    const snapDir = path.join(dataDir, "snap"); fs.mkdirSync(snapDir, { recursive: true });
    const stamp = new Date(now).toISOString(), file = path.join(snapDir, stamp.slice(0, 10) + "-" + stamp.slice(11, 13) + ".jsonl.gz");
    const r3 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 1000) / 1000 : null;
    const focus = new Set([...need, ...heldIds]);
    const rows = [];
    A.forEach((x, a) => {
      if (!full && !focus.has(a)) return;
      const p = tokens.get(a).pair, ch = p.priceChange || {}, tx = p.txns || {}, v = p.volume || {};
      const rc = rcCache[a] && rcCache[a].ok ? rcCache[a] : null, H = rc && rc.hold, f = flow[a] && !flow[a].err && now - flow[a].at < 12 * 60e3 ? flow[a] : null;
      rows.push([a, x.px, Math.round(num(x.liq)), Math.round(num(x.mc)), r3(x.ageH), r3(ch.m5), r3(ch.h1), r3(ch.h6), r3(ch.h24),
        num(tx.h1 && tx.h1.buys), num(tx.h1 && tx.h1.sells), num(tx.h6 && tx.h6.buys), num(tx.h6 && tx.h6.sells),
        Math.round(num(v.h1)), Math.round(num(v.h6)), Math.round(num(v.h24)), x.score, x.rug, x.signal[0], x.checks.map(k => k.state[0]).join(""), x.onchain[0],
        H ? H.total : null, H ? r3(H.top1) : null, H ? r3(H.top10) : null, H ? r3(H.devPct) : null, H ? r3(H.insPct) : null, rc ? num(rc.insWallets) : null,
        rc && typeof rc.lpLockedPct === "number" ? r3(rc.lpLockedPct) : null, rc && rc.auth ? (rc.auth.mint ? 1 : 0) + (rc.auth.freeze ? 2 : 0) : null,
        f ? f.ub : null, f ? f.us : null, f ? f.bu : null, f ? f.su : null, f ? f.top : null, srcOf(a)]);
    });
    if (rows.length) {
      const prev = fs.existsSync(file) ? zlib.gunzipSync(fs.readFileSync(file)).toString("utf8") : "";
      const tmp = file + ".tmp"; fs.writeFileSync(tmp, zlib.gzipSync(prev + JSON.stringify({ t: now, full, rows }) + "\n", { level: 9 })); fs.renameSync(tmp, file);
    }
    if (full) {
      fs.readdirSync(snapDir).forEach(f => { const d = Date.parse(f.slice(0, 10)); if (isFinite(d) && now - d > 60 * 86400e3) fs.unlinkSync(path.join(snapDir, f)); });
      fs.writeFileSync(path.join(snapDir, "README.txt"),
        "One file per UTC hour (older files are one per day). One line per tracker run: {t, full, rows}. full=true lines hold every scanned coin (about every 10 minutes); other lines hold only coins near a buy, with an open signal, or held by a wallet (every run).\n" +
        "Each row: 0 address, 1 priceUsd, 2 liquidityUsd, 3 marketCap, 4 pairAgeHours, 5-8 change m5, h1, h6, h24 (%), 9 buys 1h, 10 sells 1h, 11 buys 6h, 12 sells 6h, 13-15 volume 1h, 6h, 24h (USD), 16 score, 17 rugScore, 18 verdict initial (b/h/s/r/a), 19 the 12 checks in page order (p/f/n), 20 on-chain status (o/p/u), " +
        "21 holder count, 22 largest holder %, 23 top 10 %, 24 developer %, 25 insider %, 26 linked insider wallets, 27 pool locked %, 28 authorities (0 none, 1 mint, 2 freeze, 3 both), 29 distinct buyers 15 min, 30 distinct sellers 15 min, 31 bought USD 15 min, 32 sold USD 15 min, 33 largest wallet's share of 15 min volume, 34 where the coin came from (b = DexScreener boosted or promoted, t = trending pools, v = top volume, n = new pair, w = watchlist; from 11 Oct 2026 23:10 UTC). Columns 21 on are null when not looked up; rows before 11 Oct 2026 09:55 UTC stop at column 20.\n");
      snapAt = now;
    }
    meta.snapshot = rows.length;
  } catch (e) { errors.push("snapshot not saved"); }

  // 7. Save. Keep every open signal and the most recent closed ones.
  const keep = signals.filter(r => r.st === "open").concat(signals.filter(r => r.st !== "open").slice(0, 500)).sort((p, q) => q.t - p.t);
  writeJSON(path.join(dataDir, "signals.json"), { meta, signals: keep });
  const live = new Set(ids);
  Object.keys(peak).forEach(a => { if (!live.has(a)) delete peak[a]; });
  Object.keys(rcCache).forEach(a => { if (!live.has(a) || now - rcCache[a].at > 6 * 3600e3) delete rcCache[a]; });
  Object.keys(flow).forEach(a => { if (!live.has(a) || now - flow[a].at > 3600e3) delete flow[a]; });
  Object.keys(hh).forEach(a => { if (!live.has(a)) delete hh[a]; });
  writeJSON(path.join(dataDir, "cache.json"), { peak, rc: rcCache, lists, disc, run: runNo, lastSnap: snapAt, flow, gtWait, hh, follow });
  writeJSON(path.join(dataDir, "coins.json"), { t: now, trend: gtTrend, vol, fresh: fresh.slice(0, 20) });
  return { meta, signals: keep };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  run({ root }).then(({ meta, signals }) => {
    console.log("scanned " + meta.scanned + ", priced " + meta.priced + ", buys now: " + ((meta.buysNow || []).join(", ") || "none") +
      ", open " + (meta.open || 0) + ", total " + signals.length + (meta.errors.length ? ", problems: " + meta.errors.join("; ") : ""));
  }).catch(e => { console.error(e); process.exit(1); });
}
