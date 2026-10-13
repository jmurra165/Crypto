// Daily replay and tuning for the adaptive wallet.
// Once a day this replays the recorded snapshots through the current rules and through every
// one-step variation of them. A variation is adopted only if it beats the current rules on the
// older data AND on the most recent data it was not chosen on, with enough trades to mean something.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULTS, QUICK, STEADY, RECOVERY, FRESH, BRANDNEW, STRONG, DAYTWO, ADAPTIVE_START, ADAPTIVE_VERSION, GRID, LABELS, describe, freshWallet, stepWallet } from "./strategy.mjs";

const DAY = 86400e3;
const MIN_DAYS = 5, MIN_TRADES = 50, MIN_TEST_TRADES = 10, MIN_TRAIN_TRADES = 20, MARGIN = 0.5, WINDOW_DAYS = 14;
const ORIGINAL = Object.assign({}, DEFAULTS, { minLiq: 10000, confirm: false, sizeLo: 5, lockAt: 0, trailAt: 0.3, trailDrop: 0.3, halfAt: 0, fade: false });

function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } }

export function loadLines(snapDir, now) {
  const lines = [];
  if (!fs.existsSync(snapDir)) return lines;
  for (const f of fs.readdirSync(snapDir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}(-\d{2})?\.jsonl\.gz$/.test(f)) continue;
    const d = Date.parse(f.slice(0, 10)); if (!isFinite(d) || now - d > (WINDOW_DAYS + 1) * DAY) continue;
    let text; try { text = zlib.gunzipSync(fs.readFileSync(path.join(snapDir, f))).toString("utf8"); } catch (e) { continue; }
    for (const ln of text.split("\n")) {
      if (!ln) continue;
      let j; try { j = JSON.parse(ln); } catch (e) { continue; }
      if (!j || !Array.isArray(j.rows) || now - j.t > WINDOW_DAYS * DAY) continue;
      const obs = new Map();
      for (const r of j.rows) {
        const ck = String(r[19] || ""); let fails = 0; for (let i = 0; i < 10 && i < ck.length; i++) if (ck[i] === "f") fails++;
        const b1 = r[9] || 0, s1 = r[10] || 0;
        if (r[1] > 0) obs.set(r[0], { px: r[1], liq: r[2] || 0, score: r[16], rug: r[17], fails, oc: r[20] || "p", h1: r[6] || 0, m5: r[5] || 0, h24: r[8] || 0, age: r[4] == null ? null : r[4], src: r[34] || "", hold: r[21] > 0 ? r[21] : 0, hg: null,
          bp: b1 + s1 >= 20 ? b1 / (b1 + s1) : null, acc: r[14] > 0 ? r[13] / (r[14] / 6) : null });
      }
      lines.push({ t: j.t, full: j.full !== false, obs });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  // Market direction: the typical (median) one-hour move of tradeable coins, from each full snapshot, carried forward.
  let br = null;
  for (const ln of lines) { if (ln.full) { const v = [...ln.obs.values()].filter(o => o.liq >= 50000).map(o => o.h1).sort((x, y) => x - y); if (v.length >= 20) br = v[Math.floor(v.length / 2)]; } ln.breadth = br; }
  // Holder growth per hour, from each coin's own earlier holder counts (about an hour back).
  const hs = new Map();
  for (const ln of lines) for (const [a, o] of ln.obs) {
    if (!o.hold) continue;
    let arr = hs.get(a); if (!arr) { arr = []; hs.set(a, arr); }
    const lastS = arr[arr.length - 1];
    if (!lastS || (ln.t - lastS[0] >= 10 * 60e3 && o.hold !== lastS[1]) || ln.t - lastS[0] >= 30 * 60e3) arr.push([ln.t, o.hold]);
    while (arr.length && ln.t - arr[0][0] > 3 * 3600e3) arr.shift();
    let best = null;
    for (const smp of arr) { const age = ln.t - smp[0]; if (age >= 40 * 60e3 && age <= 100 * 60e3 && (!best || Math.abs(age - 3600e3) < Math.abs(ln.t - best[0] - 3600e3))) best = smp; }
    if (best && best[1] > 0) o.hg = (o.hold / best[1] - 1) * 100 * (3600e3 / (ln.t - best[0]));
  }
  return lines;
}

export function simulate(lines, P) {
  const W = freshWallet(10, lines.length ? lines[0].t : 0);
  let peak = 10, maxDD = 0;
  for (const ln of lines) {
    const eq = stepWallet(W, ln.obs, P, { now: ln.t, breadth: ln.breadth, solPx: 100, fee: 0.01, confirmMin: 60e3, confirmMax: 12 * 60e3, countMisses: ln.full, missMax: 6, keepHist: false });
    if (eq > peak) peak = eq; if (peak > 0 && (peak - eq) / peak > maxDD) maxDD = (peak - eq) / peak;
  }
  const sells = W.hist, wins = sells.filter(h => h.pnl > 0).length;
  const r1 = v => Math.round(v * 10) / 10;
  return { ret: r1(((W.equity || 10) / 10 - 1) * 100), n: sells.length, wins, dd: r1(maxDD * 100), open: Object.keys(W.pos).length };
}

function neighbours(P) {
  const out = [];
  for (const k of Object.keys(GRID)) {
    const vals = GRID[k], i = vals.indexOf(P[k]);
    const idx = i < 0 ? [0] : [i - 1, i + 1];
    for (const n of idx) if (n >= 0 && n < vals.length && vals[n] !== P[k]) out.push({ key: k, val: vals[n], P: Object.assign({}, P, { [k]: vals[n] }), label: LABELS[k](vals[n]) });
  }
  return out;
}

export function tune({ dataDir, now = Date.now(), force = false } = {}) {
  const file = path.join(dataDir, "tuning.json"), prev = readJSON(file, null);
  // Re-run early when the set of tunable rules has changed since the last report.
  const gridSig = Object.keys(GRID).join(",");
  if (!force && prev && prev.grid === gridSig && prev.ver === ADAPTIVE_VERSION && now - prev.t < DAY - 10 * 60e3) return null;
  const lines = loadLines(path.join(dataDir, "snap"), now);
  // A new hand-set starting point (after a manual review) replaces whatever the tuning had settled on.
  const carried = !!prev && prev.ver === ADAPTIVE_VERSION;
  const current = Object.assign({}, ADAPTIVE_START, carried && prev.current ? prev.current : {});
  const history = prev && Array.isArray(prev.history) ? prev.history.slice() : [];
  if (prev && !carried) history.unshift({ t: now, manual: true, text: "Starting rules replaced by hand after a review: now tunes the young-coin rules" });
  const out = { t: now, lines: lines.length, spanDays: 0, current, since: carried && prev.since ? prev.since : now, ver: ADAPTIVE_VERSION, history, table: [], grid: gridSig, ready: false, need: { days: MIN_DAYS, trades: MIN_TRADES } };
  if (lines.length < 2) { out.status = "No recorded data to replay yet."; out.currentText = describe(current); fs.writeFileSync(file, JSON.stringify(out)); return out; }
  const first = lines[0].t, last = lines[lines.length - 1].t, span = last - first;
  out.spanDays = Math.round(span / DAY * 10) / 10;
  const split = span >= 2 * DAY ? last - Math.max(DAY, span * 0.3) : null;
  const train = split ? lines.filter(l => l.t < split) : lines, test = split ? lines.filter(l => l.t >= split) : [];
  out.trainDays = Math.round(((split || last) - first) / DAY * 10) / 10; out.testDays = split ? Math.round((last - split) / DAY * 10) / 10 : 0;
  const evalP = P => ({ train: simulate(train, P), test: test.length ? simulate(test, P) : null });
  const cur = evalP(current);
  out.table.push({ label: "Current rules", kind: "current", train: cur.train, test: cur.test });
  const cands = neighbours(current).map(c => Object.assign(c, evalP(c.P)));
  cands.forEach(c => out.table.push({ label: "Change: " + c.label, kind: "variation", key: c.key, val: c.val, train: c.train, test: c.test }));
  [["Fresh launches", FRESH], ["Brand-new launches", BRANDNEW], ["Strong pumps", STRONG], ["Day-two coins", DAYTWO], ["Retired: Quick profit", QUICK], ["Retired: Established coins", STEADY], ["Retired: Recovery", RECOVERY], ["Day-one tighter rules", DEFAULTS], ["Day-one original rules", ORIGINAL]]
    .forEach(([label, P]) => { const e = evalP(P); out.table.push({ label, kind: "benchmark", train: e.train, test: e.test }); });

  const total = cur.train.n + (cur.test ? cur.test.n : 0);
  const blockers = [];
  if (out.spanDays < MIN_DAYS) blockers.push(out.spanDays + " of " + MIN_DAYS + " days of data recorded");
  if (total < MIN_TRADES) blockers.push(total + " of " + MIN_TRADES + " replayed trades");
  out.ready = !blockers.length;
  let picked = null;
  if (out.ready && cur.test) {
    const ok = cands.filter(c => c.train.n >= MIN_TRAIN_TRADES && c.test && c.test.n >= MIN_TEST_TRADES && c.train.ret > cur.train.ret && c.test.ret > cur.test.ret + MARGIN)
      .sort((a, b) => b.train.ret - a.train.ret);
    picked = ok[0] || null;
  }
  if (picked) {
    out.history = [{ t: now, key: picked.key, from: current[picked.key], to: picked.val, text: "Changed to: " + picked.label + " (was: " + LABELS[picked.key](current[picked.key]) + ")",
      train: [cur.train.ret, picked.train.ret], test: [cur.test.ret, picked.test.ret] }, ...history].slice(0, 60);
    out.current = picked.P; out.since = now;
    out.table.forEach(r => { if (r.key === picked.key && r.val === picked.val) r.picked = true; });
    out.status = "Rule changed today. " + out.history[0].text + ". On the recent data it was not chosen on, it returned " + picked.test.ret + "% against " + cur.test.ret + "% for the old rule.";
  } else if (!out.ready) {
    out.status = "Still collecting: " + blockers.join(" and ") + ". The replay runs daily and reports below, but no rule can change until both are met.";
  } else {
    out.status = "No change today. None of the " + cands.length + " one-step variations beat the current rules on both the older data and the recent data it was not chosen on.";
  }
  out.currentText = describe(out.current);
  fs.writeFileSync(file + ".tmp", JSON.stringify(out)); fs.renameSync(file + ".tmp", file);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const r = tune({ dataDir: path.join(root, "data"), force: process.argv.includes("--force") });
  console.log(r ? "tuning: " + r.status : "tuning: not due");
}
