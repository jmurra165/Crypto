// ASX announcement review: collector. Runs on GitHub Actions after the close each weekday.
// 1. Pulls price-sensitive announcements (the feed reaches back about three months).
// 2. Keeps small caps (market cap up to $2b, ordinary shares).
// 3. Lines each one up with Yahoo 5-minute prices and records what the price did after a realistic entry:
//    - announced before 10:00 (or after 15:30 / overnight): enter at the 10:15 price on the next session
//    - announced during the session: enter at the close of the first full 5-minute bar after release
//    then the return to +30 min, +2 hours and the close, plus the best and worst moves along the way.
// Output (in the folder given as the first argument, the asx-data branch):
//    events.json      every event, compact, read by the review page
//    bars.jsonl.gz    the event-day 5-minute bars, so rules can be re-tested after Yahoo's 60 days roll off
//    summary.json     headline results under the default rules, for the daily review
//    status.json      run details and any errors
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const S = await import("data:text/javascript," + encodeURIComponent(fs.readFileSync(path.join(here, "stats.js"), "utf8")));

const OUT = path.resolve(process.argv[2] || "out");
fs.mkdirSync(OUT, { recursive: true });
const M = "https://asx.api.markitdigital.com/asx-research/1.0";
const H = { "User-Agent": "Mozilla/5.0 (compatible; asx-review)", Accept: "application/json,text/csv,*/*" };
const DAY = 86400e3, MIN = 60e3;
const LOOKBACK_DAYS = 62, MAX_CAP = 2e9, HEADER_MAX_AGE = 7 * DAY;
const now = Date.now();
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, kind = "json", tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
      if (!res.ok) { errors.push(`${res.status} ${url}`); return null; }
      return kind === "json" ? await res.json() : await res.text();
    } catch (e) {
      if (i === tries - 1) { errors.push(`${e.message} ${url}`); return null; }
      await sleep(2000 * (i + 1));
    }
  }
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

// ---- Sydney time (ASX trades 10:00–16:00 Sydney time) ----
const offCache = new Map();
const fmt = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function sydOffset(ms) {
  const k = Math.floor(ms / 3600e3);
  if (!offCache.has(k)) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(k * 3600e3)).map(x => [x.type, x.value]));
    offCache.set(k, Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - k * 3600e3);
  }
  return offCache.get(k);
}
function syd(ms) { const d = new Date(ms + sydOffset(ms)); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }

// ---- state ----
const prev = readJSON(path.join(OUT, "events.json"), { events: [] });
const byKey = new Map(prev.events.map(e => [e.k, e]));
const headers = readJSON(path.join(OUT, "headers.json"), {});
const barsStore = new Map();
try { for (const ln of zlib.gunzipSync(fs.readFileSync(path.join(OUT, "bars.jsonl.gz"))).toString("utf8").split("\n")) if (ln) { const j = JSON.parse(ln); barsStore.set(j.k, j); } } catch (e) {}

// ---- 1. announcements ----
const listed = new Map();
const csv = await get("https://www.asx.com.au/asx/research/ASXListedCompanies.csv", "text");
if (csv) for (const ln of csv.split("\n")) { const m = ln.match(/^"(.*)","([A-Z0-9]{3})","(.*)"/); if (m) listed.set(m[2], { name: m[1], group: m[3] }); }

let pages = 0, fetched = 0, added = 0;
const cutoff = now - LOOKBACK_DAYS * DAY;
for (let page = 0; page < 100; page++) {
  const j = await get(`${M}/markets/announcements?page=${page}&itemsPerPage=100&priceSensitiveOnly=true`);
  const items = (j && j.data && j.data.items) || [];
  pages++;
  if (!items.length) break;
  let oldest = Infinity;
  for (const it of items) {
    const t = Date.parse(it.date); oldest = Math.min(oldest, t);
    if (!it.isPriceSensitive || t < cutoff) continue;
    fetched++;
    const code = it.symbol;
    if (!/^[A-Z0-9]{3}$/.test(code || "")) continue;           // ordinary shares only
    if (listed.size && !listed.has(code)) continue;            // not a listed company (fund, option, etc.)
    if (byKey.has(it.documentKey)) continue;
    const ci = (it.companyInfo || [])[0] || {};
    byKey.set(it.documentKey, {
      k: it.documentKey, t, c: code, h: it.headline || "",
      ty: (it.announcementTypes || []).join("; "),
      sec: ci.sector || (listed.get(code) || {}).group || "", ind: ci.industry || "",
      cat: S.categoryOf(it.headline), st: "new",
    });
    added++;
  }
  if (oldest < cutoff) break;
  await sleep(300);
}

// ---- 2. which events still need prices ----
const need = [...byKey.values()].filter(e => e.st === "new" || e.st === "pending" || (e.st === "nodata" && now - e.t < 5 * DAY));
const codes = [...new Set(need.map(e => e.c))];
console.log(`announcements: ${pages} pages, ${fetched} price-sensitive in window, ${added} new; ${need.length} events over ${codes.length} codes need prices`);

// ---- 3. headers (market cap) and prices per code ----
function parseChart(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return null;
  const q = r.indicators.quote[0], bars = [], r4 = x => x == null ? x : +x.toFixed(4);
  for (let i = 0; i < r.timestamp.length; i++) {
    const ms = r.timestamp[i] * 1000, c = q.close[i];
    if (c == null || !(c > 0)) continue;  // no trades in this bar
    const s = syd(ms);
    if (s.min < 600 || s.min > 975) continue; // outside 10:00–16:15
    bars.push({ ms, d: s.date, m: s.min, o: r4(q.open[i] ?? c), h: r4(q.high[i] ?? c), l: r4(q.low[i] ?? c), c: r4(c), v: q.volume[i] || 0 });
  }
  return bars;
}

let priced = 0, skippedCap = 0;
for (const code of codes) {
  let hd = headers[code];
  if (!hd || now - hd.at > HEADER_MAX_AGE) {
    const j = await get(`${M}/companies/${code}/header`);
    const d = j && j.data;
    hd = headers[code] = d ? { at: now, cap: d.marketCap > 0 ? d.marketCap : null, sec: d.sector || "", type: d.securityType, bid: d.priceBid, ask: d.priceAsk } : { at: now, cap: null };
    await sleep(250);
  }
  const evs = need.filter(e => e.c === code);
  if (hd.cap != null && hd.cap > MAX_CAP) { for (const e of evs) byKey.delete(e.k); skippedCap++; continue; }
  const bars = parseChart(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.AX?interval=5m&range=60d`));
  await sleep(350);
  for (const e of evs) {
    e.cap = hd.cap; if (!e.sec && hd.sec) e.sec = hd.sec;
    if (!bars || !bars.length) { e.st = "nodata"; continue; }
    Object.assign(e, outcome(e, bars));
    if (e.st === "ok") priced++;
  }
}

// What the price did after a realistic entry.
function outcome(e, bars) {
  const days = [...new Set(bars.map(b => b.d))];   // trading days with any trade, in order
  const a = syd(e.t);
  let D, mode;
  const isDay = days.includes(a.date);
  if (isDay && a.min < 600) { D = a.date; mode = "pre"; }
  else if (isDay && a.min < 930) { D = a.date; mode = "live"; }
  else { D = days.find(d => d > a.date); mode = "pre"; }
  if (a.date < days[0]) return { st: "nodata" };                          // older than Yahoo's 60 days
  if (!D) return { st: now - e.t > 4 * DAY ? "nodata" : "pending" };
  if (Date.parse(D) - Date.parse(a.date) > 5 * DAY) return { st: "nodata" }; // long suspension, not a day trade
  if (days[0] === D && mode === "pre") return { st: "nodata" }; // no prior close inside Yahoo's window
  const dayBars = bars.filter(b => b.d === D);
  const prevDay = days[days.indexOf(D) - 1];
  const prevBars = prevDay ? bars.filter(b => b.d === prevDay) : [];
  // Session not finished yet (run before the close): try again next run.
  if (D === syd(now).date && syd(now).min < 16 * 60 + 30) return { st: "pending" };

  let p0, entryIdx = -1;
  if (mode === "pre") {
    if (!prevBars.length) return { st: "nodata" };
    p0 = prevBars[prevBars.length - 1].c;
    entryIdx = dayBars.findIndex(b => b.m >= 610 && b.m <= 640);           // the 10:10 bar or the first trade within 30 min
  } else {
    const before = dayBars.filter(b => b.ms + 5 * MIN <= e.t);
    p0 = before.length ? before[before.length - 1].c : prevBars.length ? prevBars[prevBars.length - 1].c : null;
    if (p0 == null) return { st: "nodata" };
    const first = Math.ceil(e.t / (5 * MIN)) * 5 * MIN;
    entryIdx = dayBars.findIndex(b => b.ms >= first && b.ms <= first + 30 * MIN);
  }
  if (entryIdx < 0) return { st: "notrade", tod: tod(mode, a) };
  const eb = dayBars[entryIdx], entry = eb.c, entryEnd = eb.ms + 5 * MIN;
  const after = dayBars.slice(entryIdx + 1);
  const priceAt = ms => { let p = entry; for (const b of after) { if (b.ms + 5 * MIN <= ms) p = b.c; else break; } return p; };
  const last = dayBars[dayBars.length - 1];
  const r = p => +(p / entry - 1).toFixed(5);
  // Volume so far vs a normal full day (average of up to 20 earlier sessions in the data).
  const volSoFar = dayBars.slice(0, entryIdx + 1).reduce((s, b) => s + b.v, 0);
  const valSoFar = dayBars.slice(0, entryIdx + 1).reduce((s, b) => s + b.v * b.c, 0);
  const prior = days.slice(Math.max(0, days.indexOf(D) - 20), days.indexOf(D));
  const dayVols = prior.map(d => bars.filter(b => b.d === d).reduce((s, b) => s + b.v, 0));
  const avgVol = dayVols.length ? dayVols.reduce((s, x) => s + x, 0) / dayVols.length : 0;
  const hi = after.length ? Math.max(...after.map(b => b.h)) : entry;
  const lo = after.length ? Math.min(...after.map(b => b.l)) : entry;
  barsStore.set(e.k, { k: e.k, d: D, p0, b: dayBars.map(b => [b.m, b.o, b.h, b.l, b.c, b.v]) });
  return {
    st: "ok", d: D, mode, tod: tod(mode, a),
    p0, px: entry, em: eb.m + 5,
    jump: +(entry / p0 - 1).toFixed(5),
    gap: mode === "pre" ? +(dayBars[0].o / p0 - 1).toFixed(5) : null,
    r30: r(priceAt(entryEnd + 30 * MIN)),
    r2h: entryEnd + 120 * MIN <= last.ms + 5 * MIN ? r(priceAt(entryEnd + 120 * MIN)) : r(last.c),
    rc: r(last.c),
    mfe: r(hi), mae: r(lo),
    rv: avgVol > 0 ? +(volSoFar / avgVol).toFixed(3) : null,
    val: Math.round(valSoFar),
  };
}
function tod(mode, a) { if (mode === "pre") return "pre"; return a.min < 720 ? "am" : a.min < 840 ? "mid" : "pm"; }

// ---- 4. save ----
const events = [...byKey.values()].filter(e => now - e.t < 400 * DAY).sort((a, b) => b.t - a.t);
for (const e of events) if (e.st === "new") e.st = "pending";
fs.writeFileSync(path.join(OUT, "events.json"), JSON.stringify({ updated: now, events }));
fs.writeFileSync(path.join(OUT, "headers.json"), JSON.stringify(headers));
const keep = new Set(events.map(e => e.k));
fs.writeFileSync(path.join(OUT, "bars.jsonl.gz"), zlib.gzipSync([...barsStore.values()].filter(b => keep.has(b.k)).map(b => JSON.stringify(b)).join("\n")));
const ok = events.filter(e => e.st === "ok");
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ updated: now, costs: S.DEFAULT_COSTS, filter: S.DEFAULT_FILTER, summary: S.summary(ok) }, null, 1));
const counts = {}; for (const e of events) counts[e.st] = (counts[e.st] || 0) + 1;
fs.writeFileSync(path.join(OUT, "status.json"), JSON.stringify({
  updated: now, pages, fetched, added, codes: codes.length, priced, skippedCap, counts,
  first: ok.length ? Math.min(...ok.map(e => e.t)) : null, last: ok.length ? Math.max(...ok.map(e => e.t)) : null,
  errors: errors.slice(0, 50), errorCount: errors.length,
}, null, 1));
console.log("done", counts, "errors", errors.length);
