// Background tracker for Meme Radar.
// Runs on a schedule in GitHub Actions. It scores the same coins the page scans, using the
// scoring code lifted straight out of index.html (the blocks between the CORE markers), then
// records every buy signal and follows it until it exits. Output goes to data/signals.json.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.dexscreener.com";
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens/";
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

export async function run({ root, getJSON = realGetJSON, now = Date.now(), pause = 300 } = {}) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const coreSrc = [...html.matchAll(/\/\*CORE>\*\/([\s\S]*?)\/\*<CORE\*\//g)].map(m => m[1]).join("\n");
  if (!coreSrc) throw new Error("No scoring code found in index.html");
  const core = new Function(coreSrc + "\nreturn {analyse, parseReport, ADDR_RE, BUY_AT};")();
  const { analyse, parseReport, ADDR_RE, BUY_AT } = core;

  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const state = readJSON(path.join(dataDir, "signals.json"), {});
  const signals = Array.isArray(state.signals) ? state.signals : [];
  const cache = readJSON(path.join(dataDir, "cache.json"), {});
  const peak = cache.peak || {}, rcCache = cache.rc || {};
  const errors = [];

  // 1. Which coins to look at
  const wl = readJSON(path.join(root, "watchlist.json"), null);
  const watch = (Array.isArray(wl) ? wl : DEFAULT_WATCH).filter(a => ADDR_RE.test(a));
  const boosts = new Map(), trend = [];
  const disc = await Promise.allSettled(["/token-boosts/top/v1", "/token-boosts/latest/v1", "/token-profiles/latest/v1"].map(e => getJSON(API + e)));
  disc.forEach(r => {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) return;
    r.value.forEach(x => {
      if (!x || x.chainId !== "solana" || !ADDR_RE.test(x.tokenAddress || "")) return;
      if (x.totalAmount) boosts.set(x.tokenAddress, Math.max(boosts.get(x.tokenAddress) || 0, num(x.totalAmount)));
      if (!trend.includes(x.tokenAddress)) trend.push(x.tokenAddress);
    });
  });
  if (disc.every(r => r.status === "rejected")) errors.push("trending list failed");
  // GeckoTerminal allows only a few calls a minute from here, so each run asks for the new pairs
  // plus one page of each longer list, and pages from earlier runs are remembered for three hours.
  const gtPage = async (pq, p) => {
    const j = await getJSON(GT + pq + (pq.includes("?") ? "&" : "?") + "page=" + p), out = [];
    (j.data || []).forEach(d => { const a = String(((((d || {}).relationships || {}).base_token || {}).data || {}).id || "").replace(/^solana_/, ""); if (ADDR_RE.test(a) && !SKIP.has(a) && !out.includes(a)) out.push(a); });
    return out;
  };
  const lists = cache.lists || { trend: {}, vol: {} }, runNo = (cache.run || 0) + 1;
  const pool = set => [...new Set(Object.values(set).filter(e => e && now - e.at < 3 * 3600e3).flatMap(e => e.ids))];
  let fresh = [];
  try { fresh = await gtPage("/new_pools", 1); } catch (e) { errors.push("new pairs list failed (" + e.message + ")"); }
  await sleep(pause * 8);
  try { const p = (runNo % 3) + 1; lists.trend[p] = { at: now, ids: await gtPage("/trending_pools", p) }; } catch (e) { errors.push("trending pools page failed (" + e.message + ")"); }
  await sleep(pause * 8);
  try { const p = (runNo % 4) + 1; lists.vol[p] = { at: now, ids: await gtPage("/pools?sort=h24_volume_usd_desc", p) }; } catch (e) { errors.push("top volume page failed (" + e.message + ")"); }
  const gtTrend = pool(lists.trend), vol = pool(lists.vol);
  const openIds = signals.filter(r => r.st === "open").map(r => r.a);
  const ids = [...new Set([...watch, ...openIds, ...trend.slice(0, 30), ...gtTrend.slice(0, 60), ...vol.slice(0, 70), ...fresh.slice(0, 20)])].slice(0, 220);

  // 2. Prices
  const tokens = new Map(); let priceOk = false;
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
      });
    } catch (e) { errors.push("prices failed for a batch"); }
  }

  const meta = { lastRun: now, scanned: ids.length, priced: tokens.size, errors };
  if (!priceOk) {
    // Nothing reliable to act on. Record the failed run and leave every signal untouched.
    meta.lastGood = (state.meta && (state.meta.lastGood || state.meta.lastRun)) || 0;
    fs.writeFileSync(path.join(dataDir, "signals.json"), JSON.stringify({ meta, signals }));
    fs.writeFileSync(path.join(dataDir, "cache.json"), JSON.stringify({ peak, rc: rcCache, lists, run: runNo }));
    return { meta, signals };
  }
  meta.lastGood = now;

  // 3. First pass on market data alone, to decide which coins are worth an on-chain lookup
  const histOf = a => ({ pts: [], peakLiq: num(peak[a]) });
  const need = [];
  tokens.forEach((t, a) => {
    const x = analyse(t, histOf(a), undefined, boosts.get(a) || 0, null, null);
    if (openIds.includes(a) || (x.score >= BUY_AT && x.liq >= 10000 && x.rugLevel !== "high")) need.push(a);
  });
  let rcFails = 0;
  for (const a of need.slice(0, 40)) {
    const c = rcCache[a];
    if (c && now - c.at < 25 * 60e3) continue;
    if (rcFails >= 3) break;
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
      if (r.miss >= 6) { r.st = "closed"; r.x = { t: now, px: r.last, why: "No longer listed", gap: false, stale: true }; }
    }
  });

  // 6. Log new buy signals
  const buysNow = [];
  A.forEach((x, a) => {
    if (x.signal !== "buy" || x.onchain === "pending" || !(x.px > 0)) return;
    const t = tokens.get(a), sym = (t.pair.baseToken || {}).symbol || "?";
    buysNow.push(sym);
    if (signals.some(r => r.a === a && (r.st === "open" || (r.x && now - r.x.t < 3600e3)))) return;
    signals.unshift({ a, sym, pool: t.pair.pairAddress || "", t: now, px: x.px, score: x.score, conf: x.conf, pass: x.passN, of: x.checks.length,
      failed: x.checks.filter(c => c.state === "fail").map(c => c.name), r: {}, st: "open", hi: x.px, lo: x.px, last: x.px, lastT: now, now: "buy" });
  });
  meta.buysNow = buysNow;
  meta.open = signals.filter(r => r.st === "open").length;

  // 6b. Keep a snapshot of every coin's inputs and verdict, so rule changes can later be replayed
  //     against exactly what the tracker saw at the time. One compressed file per day.
  try {
    const snapDir = path.join(dataDir, "snap"); fs.mkdirSync(snapDir, { recursive: true });
    const day = new Date(now).toISOString().slice(0, 10), file = path.join(snapDir, day + ".jsonl.gz");
    const r3 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 1000) / 1000 : null;
    const rows = [];
    A.forEach((x, a) => {
      const p = tokens.get(a).pair, ch = p.priceChange || {}, tx = p.txns || {}, v = p.volume || {};
      rows.push([a, x.px, Math.round(num(x.liq)), Math.round(num(x.mc)), r3(x.ageH), r3(ch.m5), r3(ch.h1), r3(ch.h6), r3(ch.h24),
        num(tx.h1 && tx.h1.buys), num(tx.h1 && tx.h1.sells), num(tx.h6 && tx.h6.buys), num(tx.h6 && tx.h6.sells),
        Math.round(num(v.h1)), Math.round(num(v.h6)), Math.round(num(v.h24)), x.score, x.rug, x.signal[0], x.checks.map(k => k.state[0]).join(""), x.onchain[0]]);
    });
    const prev = fs.existsSync(file) ? zlib.gunzipSync(fs.readFileSync(file)).toString("utf8") : "";
    fs.writeFileSync(file, zlib.gzipSync(prev + JSON.stringify({ t: now, rows }) + "\n", { level: 9 }));
    fs.readdirSync(snapDir).forEach(f => { const d = Date.parse(f.slice(0, 10)); if (isFinite(d) && now - d > 60 * 86400e3) fs.unlinkSync(path.join(snapDir, f)); });
    if (!fs.existsSync(path.join(snapDir, "README.txt"))) fs.writeFileSync(path.join(snapDir, "README.txt"),
      "One line per tracker run: {t, rows}. Each row: address, priceUsd, liquidityUsd, marketCap, pairAgeHours, change m5, h1, h6, h24 (%), buys 1h, sells 1h, buys 6h, sells 6h, volume 1h, 6h, 24h (USD), score, rugScore, verdict initial (b/h/s/r/a), the 12 checks in page order (p/f/n), on-chain status (o/p/u).\n");
    meta.snapshot = rows.length;
  } catch (e) { errors.push("snapshot not saved"); }

  // 7. Save. Keep every open signal and the most recent closed ones.
  const keep = signals.filter(r => r.st === "open").concat(signals.filter(r => r.st !== "open").slice(0, 500)).sort((p, q) => q.t - p.t);
  fs.writeFileSync(path.join(dataDir, "signals.json"), JSON.stringify({ meta, signals: keep }));
  const live = new Set(ids);
  Object.keys(peak).forEach(a => { if (!live.has(a)) delete peak[a]; });
  Object.keys(rcCache).forEach(a => { if (!live.has(a) || now - rcCache[a].at > 6 * 3600e3) delete rcCache[a]; });
  fs.writeFileSync(path.join(dataDir, "cache.json"), JSON.stringify({ peak, rc: rcCache, lists, run: runNo }));
  fs.writeFileSync(path.join(dataDir, "coins.json"), JSON.stringify({ t: now, trend: gtTrend, vol, fresh: fresh.slice(0, 20) }));
  return { meta, signals: keep };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  run({ root }).then(({ meta, signals }) => {
    console.log("scanned " + meta.scanned + ", priced " + meta.priced + ", buys now: " + ((meta.buysNow || []).join(", ") || "none") +
      ", open " + (meta.open || 0) + ", total " + signals.length + (meta.errors.length ? ", problems: " + meta.errors.join("; ") : ""));
  }).catch(e => { console.error(e); process.exit(1); });
}
