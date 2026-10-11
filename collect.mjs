// Background tracker for Meme Radar.
// Runs on a schedule in GitHub Actions. It scores the same coins the page scans, using the
// scoring code lifted straight out of index.html (the blocks between the CORE markers), then
// records every buy signal and follows it until it exits. Output goes to data/signals.json.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DEFAULTS, ADAPTIVE_START, describe, freshWallet, stepWallet } from "./strategy.mjs";
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
  const openIds = signals.filter(r => r.st === "open").map(r => r.a);
  const ids = [...new Set([...watch, ...openIds, ...trend.slice(0, 30), ...gtTrend.slice(0, 60), ...vol.slice(0, 70), ...fresh.slice(0, 20)])].slice(0, 220);

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
    writeJSON(path.join(dataDir, "cache.json"), { peak, rc: rcCache, lists, disc, run: runNo, lastSnap: num(cache.lastSnap) });
    return { meta, signals };
  }
  meta.lastGood = now;

  // 3. First pass on market data alone, to decide which coins are worth an on-chain lookup
  const histOf = a => ({ pts: [], peakLiq: num(peak[a]) });
  //    Coins with an open signal or held by a wallet always get one; after that, the 60 strongest
  //    scores with tradeable liquidity, so their holder figures are on record for later analysis.
  const heldIds = [...new Set(["wallet.json", "wallet-b.json"].flatMap(f => Object.keys((readJSON(path.join(dataDir, f), {}) || {}).pos || {})))];
  const need = [], cand = [];
  tokens.forEach((t, a) => {
    const x = analyse(t, histOf(a), undefined, boosts.get(a) || 0, null, null);
    if (openIds.includes(a) || heldIds.includes(a)) need.push(a);
    else if (x.score >= 20 && x.liq >= 10000) cand.push([a, x.score]);
  });
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

  // 6a. Auto wallet: play money that buys every new buy signal and sells when the signal exits.
  const cfg = Object.assign({ startSol: 10, perSignalPct: 5, feePct: 1, resetId: 0 }, (readJSON(path.join(root, "config.json"), {}).wallet) || {});
  let W = readState(path.join(dataDir, "wallet.json"), null);
  if (!W || W.resetId !== cfg.resetId || !W.pos) W = { resetId: cfg.resetId, started: now, start: cfg.startSol, cash: cfg.startSol, pos: {}, hist: [], eq: [], skipped: 0 };
  W.cfg = cfg;
  if (solPx > 0) {
    const fee = Math.max(0, Math.min(20, Number(cfg.feePct) || 0)) / 100;
    const sellValue = (p, x) => { const gross = p.qty * x.px, imp = x.liq ? gross / (x.liq / 2 + gross) : 1; return gross * (1 - imp) * (1 - fee) / solPx; };
    const openSet = new Set(signals.filter(r => r.st === "open").map(r => r.a));
    Object.keys(W.pos).forEach(a => {
      if (openSet.has(a)) return;
      const p = W.pos[a], x = A.get(a), rec = signals.find(r => r.a === a && r.st === "closed") || {}, ex = rec.x || {};
      const out = x && x.px > 0 && !ex.stale ? sellValue(p, x) : 0;
      W.cash += out;
      W.hist.unshift({ t: now, side: "sell", sym: p.sym, a, amt: out, px: x && x.px > 0 ? x.px : num(ex.px), pnl: out - p.cost, cost: p.cost, held: now - p.at,
        why: (ex.why || "Signal ended") + (out === 0 ? ", could not be sold" : ""), checks: p.checks, conf: p.conf, buyPx: p.px0, buyT: p.at });
      delete W.pos[a];
    });
    const holdings = () => Object.keys(W.pos).reduce((t, a) => { const p = W.pos[a], x = A.get(a); if (x && x.px > 0) { p.val = sellValue(p, x); p.px = x.px; p.now = x.signal; } return t + num(p.val); }, 0);
    let equity = W.cash + holdings();
    openedNow.forEach(a => {
      const x = A.get(a), t = tokens.get(a); if (W.pos[a] || !x || !t) return;
      const amt = Math.min(equity * (Number(cfg.perSignalPct) || 5) / 100, W.cash);
      if (!(amt >= 0.01)) { W.skipped = (W.skipped || 0) + 1; return; }
      const usdIn = amt * solPx, imp = x.liq ? usdIn / (x.liq / 2 + usdIn) : 0.5, fill = x.px * (1 + imp), qty = (usdIn - amt * fee * solPx) / fill;
      const sym = (t.pair.baseToken || {}).symbol || "?", checks = x.passN + "/" + x.checks.length;
      W.pos[a] = { sym, qty, cost: amt, at: now, px0: fill, checks, conf: x.conf };
      W.cash -= amt;
      W.hist.unshift({ t: now, side: "buy", sym, a, amt, px: fill, checks, conf: x.conf });
    });
    equity = W.cash + holdings();
    W.equity = equity; W.solPx = solPx; W.t = now;
    const last = W.eq[W.eq.length - 1];
    if (!last || now - last.t >= 4.5 * 60e3) W.eq.push({ t: now, v: Math.round(equity * 1e4) / 1e4 });
    if (W.eq.length > 2500) W.eq = W.eq.filter((_, i) => i % 2 === 0 || i > W.eq.length - 400);
    W.hist = W.hist.slice(0, 800);
    writeJSON(path.join(dataDir, "wallet.json"), W);
    meta.wallet = Math.round(equity * 1e4) / 1e4;
  } else errors.push("no SOL price, auto wallet not updated");

  // 6c. Rule-driven wallets, stepped by the shared engine in strategy.mjs.
  //     "wallet-b" keeps the fixed tighter rules. "wallet-c" uses whatever rules the daily tuning last settled on.
  {
    const obs = new Map();
    A.forEach((x, a) => {
      const p = tokens.get(a).pair, ch = p.priceChange || {}, tx = (p.txns || {}).h1 || {}, v = p.volume || {}, b1 = num(tx.buys), s1 = num(tx.sells);
      obs.set(a, { px: x.px, liq: num(x.liq), score: x.score, rug: x.rug, fails: x.checks.slice(0, 10).filter(k => k.state === "fail").length, oc: x.onchain[0],
        h1: num(ch.h1), m5: num(ch.m5), bp: b1 + s1 >= 20 ? b1 / (b1 + s1) : null, acc: num(v.h6) > 0 ? num(v.h1) / (num(v.h6) / 6) : null });
    });
    const fee = Math.max(0, Math.min(20, Number(cfg.feePct) || 0)) / 100;
    const tuning = readJSON(path.join(dataDir, "tuning.json"), null);
    const adaptive = Object.assign({}, ADAPTIVE_START, tuning && tuning.current ? tuning.current : {});
    const info = a => { const x = A.get(a), t = tokens.get(a); return { sym: (t && (t.pair.baseToken || {}).symbol) || "?", checks: x ? x.passN + "/" + x.checks.length : "", conf: x ? x.conf : "" }; };
    const ruleWallet = (file, P, idKey, metaKey, extra) => {
      const rid = num(cfg[idKey]);
      let R = readState(path.join(dataDir, file), null);
      if (!R || R.resetId !== rid || !R.pos) R = freshWallet(cfg.startSol, now, { resetId: rid });
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
    ruleWallet("wallet-b.json", DEFAULTS, "resetIdB", "walletB");
    ruleWallet("wallet-c.json", adaptive, "resetIdC", "walletC", { tuned: tuning ? { since: tuning.since, changes: (tuning.history || []).length, ready: !!tuning.ready } : null });
  }

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
        f ? f.ub : null, f ? f.us : null, f ? f.bu : null, f ? f.su : null, f ? f.top : null]);
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
        "21 holder count, 22 largest holder %, 23 top 10 %, 24 developer %, 25 insider %, 26 linked insider wallets, 27 pool locked %, 28 authorities (0 none, 1 mint, 2 freeze, 3 both), 29 distinct buyers 15 min, 30 distinct sellers 15 min, 31 bought USD 15 min, 32 sold USD 15 min, 33 largest wallet's share of 15 min volume. Columns 21 on are null when not looked up; rows before 11 Oct 2026 09:55 UTC stop at column 20.\n");
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
  writeJSON(path.join(dataDir, "cache.json"), { peak, rc: rcCache, lists, disc, run: runNo, lastSnap: snapAt, flow, gtWait });
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
