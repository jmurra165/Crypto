// Daily signal research.
// Tests candidate buy signals against what prices actually did afterwards, using the tracker's own
// recorded snapshots. Each signal is scored on the older part of the data and separately on the most
// recent part, so a pattern only counts if it shows up in both. Output: data/research.json.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const DAY = 86400e3, MIN = 60e3, WINDOW_DAYS = 14, GAP = 60 * MIN, VERSION = 4;
const MIN_CASES = 30;   // per part, before a verdict is given

function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } }

// Per-coin history, thinned to one observation every ~4 minutes so two weeks fits comfortably in memory.
function loadSeries(snapDir, now) {
  const S = new Map(); let first = Infinity, last = 0, lines = 0;
  if (!fs.existsSync(snapDir)) return { S, first: 0, last: 0, lines };
  for (const f of fs.readdirSync(snapDir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}(-\d{2})?\.jsonl\.gz$/.test(f)) continue;
    const d = Date.parse(f.slice(0, 10)); if (!isFinite(d) || now - d > (WINDOW_DAYS + 1) * DAY) continue;
    let text; try { text = zlib.gunzipSync(fs.readFileSync(path.join(snapDir, f))).toString("utf8"); } catch (e) { continue; }
    for (const ln of text.split("\n")) {
      if (!ln) continue;
      let j; try { j = JSON.parse(ln); } catch (e) { continue; }
      if (!j || !Array.isArray(j.rows) || now - j.t > WINDOW_DAYS * DAY) continue;
      lines++; if (j.t < first) first = j.t; if (j.t > last) last = j.t;
      for (const r of j.rows) {
        if (!(r[1] > 0)) continue;
        let arr = S.get(r[0]); if (!arr) { arr = []; S.set(r[0], arr); }
        const prev = arr[arr.length - 1];
        if (prev && j.t - prev.t < 4 * MIN) continue;
        const ck = String(r[19] || ""); let fails = 0; for (let i = 0; i < 10 && i < ck.length; i++) if (ck[i] === "f") fails++;
        const b1 = r[9] || 0, s1 = r[10] || 0;
        arr.push({ t: j.t, px: r[1], liq: r[2] || 0, mc: r[3] || 0, age: r[4] == null ? null : r[4], m5: r[5] || 0, h1: r[6] || 0, h6: r[7] || 0, h24: r[8] || 0,
          bp: b1 + s1 >= 20 ? b1 / (b1 + s1) : null, acc: r[14] > 0 ? r[13] / (r[14] / 6) : null,
          score: r[16], rug: r[17], sig: r[18], fails, hold: r[21] == null ? null : r[21], ub: r[29] == null ? null : r[29], us: r[30] == null ? null : r[30], src: r.length > 34 ? String(r[34] || "") : null });
      }
    }
  }
  S.forEach(arr => arr.sort((a, b) => a.t - b.t));
  return { S, first: isFinite(first) ? first : 0, last, lines };
}

// The observation about `mins` earlier, if one exists within a reasonable window.
const back = (arr, i, mins) => { const t = arr[i].t - mins * MIN; for (let k = i - 1; k >= 0; k--) { if (arr[k].t <= t + 3 * MIN) return arr[k].t >= t - 15 * MIN ? arr[k] : null; } return null; };
const safe = o => o.liq >= 50000 && o.rug < 30 && o.sig !== "r" && o.sig !== "a";

// Every candidate is a plain rule on what was known at the time. `what` is shown on the page.
const SIGNALS = [
  { id: "base", name: "Any tradeable coin", what: "The comparison group: every coin with at least $50k of liquidity and a rug score under 30.", f: o => safe(o) },
  { id: "buy", name: "Current buy rule", what: "Score of 35 or more with no more than one failed safety check.", f: o => safe(o) && o.score >= 35 && o.fails <= 1 },
  { id: "score60", name: "Very strong score", what: "Score of 60 or more.", f: o => safe(o) && o.score >= 60 },
  { id: "deep", name: "Buy rule, deep pools only", what: "Score of 35 or more with at least $250k of liquidity.", f: o => safe(o) && o.score >= 35 && o.liq >= 250000 },
  { id: "downday", name: "Down on the day, now being bought", what: "Lower than 24 hours ago, with a score of 35 or more.", f: o => safe(o) && o.h24 < 0 && o.score >= 35 },
  { id: "earlydown", name: "Early: down on the day, not yet moving", what: "Lower than 24 hours ago, score of 20 or more, and up less than 5% in the last hour. Tests buying before the run rather than during it.", f: o => safe(o) && o.h24 < 0 && o.score >= 20 && o.h1 < 5 },
  { id: "calmbuy", name: "Buy rule before the run", what: "The current buy rule, but only while the price is up less than 5% in the hour and less than 50% on the day.", f: o => safe(o) && o.score >= 35 && o.fails <= 1 && o.h1 < 5 && o.h24 < 50 },
  { id: "downturn", name: "Down on the day, turning up", what: "Lower than 24 hours ago, score of 20 or more, and rising over the last 5 minutes.", f: o => safe(o) && o.h24 < 0 && o.score >= 20 && o.m5 > 0 },
  { id: "bounce", name: "Bounce after a sharp fall", what: "Down 15% or more over 6 hours, up 2% or more in the last 5 minutes, with at least half of trades being buys.", f: o => safe(o) && o.h6 <= -15 && o.m5 >= 2 && o.bp != null && o.bp >= 0.5 },
  { id: "pullback", name: "First pullback after a buy signal", what: "Reached a score of 35 or more within the last hour, has since dropped 8% or more from its high, and is rising again.",
    f: (o, arr, i) => { if (!safe(o) || o.m5 <= 0 || o.score < 15) return false; let hi = 0, had = false; for (let k = i - 1; k >= 0 && arr[k].t >= o.t - 60 * MIN; k--) { if (arr[k].px > hi) hi = arr[k].px; if (arr[k].score >= 35) had = true; } return had && hi > 0 && o.px <= hi * 0.92; } },
  { id: "flow", name: "Buying builds before the price moves", what: "At least 60% of the hour's trades are buys and volume is 1.5 times its 6-hour average, while the price is up less than 10% in the hour.", f: o => safe(o) && o.bp != null && o.bp >= 0.6 && o.acc != null && o.acc >= 1.5 && o.h1 < 10 && o.m5 > 0 },
  { id: "surge", name: "Volume surge, quiet price", what: "Volume at 2.5 times its 6-hour average while the price has moved less than 5% in the hour.", f: o => safe(o) && o.acc != null && o.acc >= 2.5 && Math.abs(o.h1) < 5 },
  { id: "rising", name: "Score climbing fast", what: "Score up 15 points or more in about 15 minutes, before the price is up 15% in the hour.", f: (o, arr, i) => { const p = back(arr, i, 15); return safe(o) && !!p && o.score - p.score >= 15 && o.score >= 15 && o.h1 < 15; } },
  { id: "holders", name: "Holder count growing", what: "Holder count up 1% or more over about an hour.", f: (o, arr, i) => { const p = back(arr, i, 60); return safe(o) && !!p && o.hold > 0 && p.hold > 0 && o.hold / p.hold - 1 >= 0.01; } },
  { id: "holdersflat", name: "Holders growing, price flat", what: "Holder count up 1% or more over about an hour while the price has moved less than 10%.", f: (o, arr, i) => { const p = back(arr, i, 60); return safe(o) && !!p && o.hold > 0 && p.hold > 0 && o.hold / p.hold - 1 >= 0.01 && Math.abs(o.h1) < 10; } },
  { id: "liqadd", name: "Liquidity being added", what: "Pool liquidity up 5% or more over about an hour while the price is up less than 5%.", f: (o, arr, i) => { const p = back(arr, i, 60); return safe(o) && !!p && p.liq > 0 && o.liq / p.liq - 1 >= 0.05 && o.px / p.px - 1 < 0.05; } },
  { id: "buyers", name: "More distinct buyers than sellers", what: "At least 8 different wallets buying in the last 15 minutes, and 1.5 times as many buyers as sellers.", f: o => safe(o) && o.ub != null && o.ub >= 8 && o.ub >= (o.us || 0) * 1.5 },
  { id: "buyersflat", name: "More buyers than sellers, price flat", what: "As above, while the price is up less than 10% in the hour.", f: o => safe(o) && o.ub != null && o.ub >= 8 && o.ub >= (o.us || 0) * 1.5 && o.h1 < 10 },
  { id: "bigsteady", name: "Large coin with a positive score", what: "Market cap of $50M or more with a score of 20 or more.", f: o => safe(o) && o.mc >= 5e7 && o.score >= 20 },
  { id: "noholders", name: "Buy rule, holder count not surging", what: "The current buy rule, leaving out coins whose holder count grew 1% or more over the last hour.", f: (o, arr, i) => { const p = back(arr, i, 60); return safe(o) && o.score >= 35 && o.fails <= 1 && !(p && o.hold > 0 && p.hold > 0 && o.hold / p.hold - 1 >= 0.01); } },
  { id: "young", name: "Young coin pumping", what: "Under 24 hours old, at least $50k of liquidity and up 20% or more in the last hour, whatever its rug score. A pulled pool counts as a total loss.", f: o => o.liq >= 50000 && o.age != null && o.age < 24 && o.h1 >= 20 },
  { id: "younglo", name: "Young coin pumping, low rug score", what: "As above, with a rug score under 30. This is what the fresh-launches wallet buys.", f: o => o.liq >= 50000 && o.age != null && o.age < 24 && o.h1 >= 20 && o.rug != null && o.rug < 30 },
  { id: "youngmid", name: "Young coin pumping, rug score 30 to 59", what: "As above, with a rug score from 30 to 59.", f: o => o.liq >= 50000 && o.age != null && o.age < 24 && o.h1 >= 20 && o.rug != null && o.rug >= 30 && o.rug < 60 },
  { id: "younghi", name: "Young coin pumping, rug score 60+", what: "As above, with a rug score of 60 or more (flagged as a rug risk).", f: o => o.liq >= 50000 && o.age != null && o.age < 24 && o.h1 >= 20 && o.rug != null && o.rug >= 60 },
  { id: "srcboost", name: "Source: paid-promotion lists", what: "Any tradeable coin that came from DexScreener's boosted or promoted lists. Shows whether promoted coins are worse bets than the rest.", f: o => safe(o) && o.src != null && o.src.includes("b") },
  { id: "srcnot", name: "Source: not promoted", what: "Any tradeable coin that did not come from the paid-promotion lists.", f: o => safe(o) && o.src != null && !o.src.includes("b") },
  { id: "srcvol", name: "Source: top-volume list", what: "Any tradeable coin from the highest-volume pools of the last 24 hours.", f: o => safe(o) && o.src != null && o.src.includes("v") },
  { id: "srctrend", name: "Source: trending pools", what: "Any tradeable coin from GeckoTerminal's trending pools.", f: o => safe(o) && o.src != null && o.src.includes("t") },
  { id: "buyboost", name: "Buy rule on promoted coins", what: "The current buy rule, promoted coins only.", f: o => safe(o) && o.score >= 35 && o.fails <= 1 && o.src != null && o.src.includes("b") },
  { id: "buynot", name: "Buy rule on coins not promoted", what: "The current buy rule, leaving out promoted coins.", f: o => safe(o) && o.score >= 35 && o.fails <= 1 && o.src != null && !o.src.includes("b") }
];

// What happened after a case: the move after one hour, and whether +10% or -10% came first within two hours.
// Entry timing: where the price sat between the low and high of the 3 hours either side (0 = the low, 1 = the high),
// and how far it had already risen from the low of the previous 3 hours.
function timing(arr, i) {
  const o = arr[i], W = 180 * MIN; let lo = o.px, hi = o.px, preLo = o.px, nPre = 0, nPost = 0, tPre = o.t, tPost = o.t;
  for (let k = i - 1; k >= 0 && arr[k].t >= o.t - W; k--) { const p = arr[k].px; if (p < lo) lo = p; if (p > hi) hi = p; if (p < preLo) preLo = p; nPre++; tPre = arr[k].t; }
  for (let k = i + 1; k < arr.length && arr[k].t <= o.t + W; k++) { const p = arr[k].px; if (p < lo) lo = p; if (p > hi) hi = p; nPost++; tPost = arr[k].t; }
  if (nPre < 6 || nPost < 6 || o.t - tPre < 150 * MIN || tPost - o.t < 150 * MIN || !(hi > lo)) return null;
  return { pos: (o.px - lo) / (hi - lo), runup: o.px / preLo - 1 };
}
function outcome(arr, i) {
  const o = arr[i]; let r60 = null, first = 0, pulled = false;
  for (let k = i + 1; k < arr.length; k++) {
    const dt = arr[k].t - o.t, r = arr[k].px / o.px - 1;
    if (dt > 135 * MIN) break;
    // The pool was emptied: the price shown may look fine, but nothing could have been sold. A total loss.
    if (dt <= 80 * MIN && o.liq > 0 && arr[k].liq < Math.max(5000, o.liq * 0.2)) { pulled = true; if (!first) first = -1; break; }
    if (!first && dt <= 120 * MIN) { if (r >= 0.1) first = 1; else if (r <= -0.1) first = -1; }
    if (r60 == null && dt >= 57 * MIN && dt <= 80 * MIN) r60 = r;
  }
  if (pulled) r60 = -1;
  if (r60 == null) return null;
  const tm = timing(arr, i);
  return { r60: Math.max(-1, Math.min(1, r60)), first, pulled, pos: tm ? tm.pos : null, runup: tm ? tm.runup : null };
}
function stats(cases) {
  const v = cases.map(c => c.r60).sort((a, b) => a - b), n = v.length;
  if (!n) return { n: 0 };
  const r1 = x => Math.round(x * 1000) / 10;
  const up = cases.filter(c => c.first === 1).length, down = cases.filter(c => c.first === -1).length;
  const med = a => { a = a.slice().sort((x, y) => x - y); const m = a.length; return m % 2 ? a[(m - 1) / 2] : (a[m / 2 - 1] + a[m / 2]) / 2; };
  const tc = cases.filter(c => c.pos != null), tn = tc.length;
  const timingStats = tn ? { tn, pos: Math.round(med(tc.map(c => c.pos)) * 100) / 100, top: Math.round(tc.filter(c => c.pos >= 2 / 3).length / tn * 100), bottom: Math.round(tc.filter(c => c.pos <= 1 / 3).length / tn * 100), runup: r1(med(tc.map(c => c.runup))) } : { tn: 0 };
  return { ...timingStats, pulled: cases.filter(c => c.pulled).length, n, med: r1(n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2), avg: r1(v.reduce((a, b) => a + b, 0) / n), beat: Math.round(v.filter(x => x > 0.03).length / n * 100), up, down, hit: up + down ? Math.round(up / (up + down) * 100) : null };
}

export function research({ dataDir, now = Date.now(), force = false } = {}) {
  const file = path.join(dataDir, "research.json"), prev = readJSON(file, null);
  const sigList = SIGNALS.map(s => s.id).join(",") + "|" + VERSION;
  if (!force && prev && prev.sig === sigList && now - prev.t < DAY - 10 * MIN) return null;
  const { S, first, last, lines } = loadSeries(path.join(dataDir, "snap"), now);
  const span = last - first, spanDays = Math.round(span / DAY * 10) / 10;
  const split = span >= 2 * DAY ? last - Math.max(DAY, span * 0.3) : null;
  const rows = SIGNALS.map(sg => {
    const all = [], older = [], recent = [];
    S.forEach(arr => {
      let lastHit = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i]; if (o.t - lastHit < GAP) continue;
        let hit = false; try { hit = !!sg.f(o, arr, i); } catch (e) { hit = false; }
        if (!hit) continue;
        const oc = outcome(arr, i); if (!oc) continue;
        lastHit = o.t; all.push(oc); (split && o.t >= split ? recent : older).push(oc);
      }
    });
    return { id: sg.id, name: sg.name, what: sg.what, all: stats(all), older: stats(older), recent: split ? stats(recent) : null };
  });
  const base = rows[0];
  rows.forEach(r => {
    if (r.id === "base") { r.verdict = "Comparison group"; r.tone = "base"; return; }
    const edge = p => (r[p] && r[p].n && base[p] && base[p].n ? Math.round((r[p].avg - base[p].avg) * 10) / 10 : null);
    r.edgeAll = edge("all"); r.edgeOlder = edge("older"); r.edgeRecent = edge("recent");
    if (!split) { r.verdict = r.all.n < MIN_CASES ? "Too few cases yet (" + r.all.n + ")" : "Needs more days before it can be judged"; r.tone = "wait"; }
    else if (r.older.n < MIN_CASES || r.recent.n < MIN_CASES) { r.verdict = "Too few cases yet (" + r.older.n + " older, " + r.recent.n + " recent)"; r.tone = "wait"; }
    else if (r.edgeOlder >= 1.5 && r.edgeRecent >= 1.5 && r.recent.avg > 2.5 && (r.recent.hit == null || r.recent.hit >= 50)) { r.verdict = "Promising: ahead of the average coin and of costs in both periods"; r.tone = "good"; }
    else if (r.edgeOlder >= 1 && r.edgeRecent >= 1) { r.verdict = "Ahead of the average coin in both periods, but not by enough to cover costs"; r.tone = "some"; }
    else if (r.edgeOlder <= -1 && r.edgeRecent <= -1) { r.verdict = "Worse than the average coin in both periods"; r.tone = "bad"; }
    else { r.verdict = "No consistent difference from the average coin"; r.tone = "none"; }
  });
  const good = rows.filter(r => r.tone === "good").map(r => r.name);
  const status = !split
    ? "Collecting: " + spanDays + " days of data so far. Each signal needs at least 2 days and " + MIN_CASES + " cases in both the older and the recent period before it gets a verdict. The figures below are early and unreliable."
    : good.length ? "Promising so far: " + good.join("; ") + ". These are leads to test in a wallet, not proof."
    : "No signal is ahead of the average coin by enough to cover costs in both periods yet.";
  const out = { t: now, sig: sigList, spanDays, lines, coins: S.size, split: !!split, olderDays: Math.round(((split || last) - first) / DAY * 10) / 10, recentDays: split ? Math.round((last - split) / DAY * 10) / 10 : 0, minCases: MIN_CASES, status, rows };
  fs.writeFileSync(file + ".tmp", JSON.stringify(out)); fs.renameSync(file + ".tmp", file);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const r = research({ dataDir: path.join(root, "data"), force: process.argv.includes("--force") });
  console.log(r ? "research: " + r.status : "research: not due");
}
