// ASX Radar: mock trading wallets. Simulation only; no broker is connected.
// Each wallet starts with $10,000 and trades its own fixed rule from the collector's recorded events.
// Live results count from the paper-rule lock (14 Oct 2026). The same rules are also replayed over all
// earlier data as a backtest, shown separately so it is never mixed up with the live record.
// Usage: node asx/wallets.mjs <data folder>   (reads events.json and bars.jsonl.gz, writes wallets.json)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const S = await import("data:text/javascript," + encodeURIComponent(fs.readFileSync(path.join(here, "stats.js"), "utf8")));
const OUT = path.resolve(process.argv[2] || "out");

export const ACCOUNT = {
  start: 10000,      // AUD per wallet
  sizePct: 20,       // each buy uses 20% of the wallet's value at the start of that day
  maxPerDay: 5,      // at most 5 buys a day, first come first served
  maxOfTraded: 10,   // never buy more than 10% of the dollars traded in the stock by entry
  minParcel: 500,    // skip if the parcel would be smaller than this
};

export const WALLETS = [
  { key: "paper", name: "Paper rule", desc: "The locked rule: jumped 5%+ by entry, 50c+ share, $250k+ traded; sells at the close.", rule: S.PAPER_RULE, exit: { type: "close" } },
  { key: "stops", name: "Paper rule + stops", desc: "Same buys, but takes profit at +8% or cuts at −4% during the day; otherwise sells at the close.", rule: S.PAPER_RULE, exit: { type: "bracket", tp: 0.08, sl: 0.04 } },
  { key: "bounce", name: "Big-drop bounce", desc: "Buys 20c+ shares that dropped 15%+ by entry with $20k+ traded; sells at the close.", rule: { ...S.DEFAULT_FILTER, side: "down", minJump: 15, minPx: 0.2, minVal: 20000, horizon: "rc" }, exit: { type: "close" } },
  { key: "control", name: "Control (no filters)", desc: "Any 5%+ jump with $20k+ traded, any share price; sells at the close. The yardstick: shows what costs do to an unfiltered strategy.", rule: { ...S.DEFAULT_FILTER, horizon: "rc" }, exit: { type: "close" } },
];

const COSTS = S.DEFAULT_COSTS;

// Exit price from the event-day bars. Stop is checked before take-profit inside a bar (the cautious
// assumption), and a bar that opens beyond either level fills at its open.
function exitReturn(e, bars, exit) {
  if (exit.type === "close" || !bars) return { r: e.rc, why: "close" };
  const b = bars.b, start = b.findIndex(x => x[0] === e.em - 5);
  if (start < 0) return { r: e.rc, why: "close" };
  const entry = e.px, stop = entry * (1 - exit.sl), take = entry * (1 + exit.tp);
  for (let i = start + 1; i < b.length; i++) {
    const [, o, h, l] = b[i];
    if (o <= stop) return { r: o / entry - 1, why: "stop" };
    if (o >= take) return { r: o / entry - 1, why: "target" };
    if (l <= stop) return { r: -exit.sl, why: "stop" };
    if (h >= take) return { r: exit.tp, why: "target" };
  }
  return { r: e.rc, why: "close" };
}

export function simulate(events, barsByKey, w, from, to = Infinity) {
  const evs = S.filterEvents(events, w.rule).filter(e => e.t >= from && e.t < to).sort((a, b) => a.t - b.t);
  const byDay = new Map();
  for (const e of evs) { if (!byDay.has(e.d)) byDay.set(e.d, []); byDay.get(e.d).push(e); }
  let cash = ACCOUNT.start;
  const trades = [], curve = [];
  for (const d of [...byDay.keys()].sort()) {
    const dayStart = cash; let n = 0;
    for (const e of byDay.get(d).sort((a, b) => a.em - b.em)) {
      if (n >= ACCOUNT.maxPerDay) break;
      const parcel = Math.min(dayStart * ACCOUNT.sizePct / 100, e.val * ACCOUNT.maxOfTraded / 100);
      if (parcel < ACCOUNT.minParcel) continue;
      const shares = Math.floor(parcel / e.px); if (shares < 1) continue;
      const cost = shares * e.px;
      const { r, why } = exitReturn(e, barsByKey.get(e.k), w.exit);
      // Spread and slippage in price terms on the way in and out, brokerage per side in dollars.
      const spreadFrac = (COSTS.spreadTicks * S.tick(e.px)) / e.px + COSTS.slipPct / 100;
      const pnl = cost * (r - spreadFrac) - 2 * COSTS.brokerage;
      cash += pnl; n++;
      trades.push({ k: e.k, t: e.t, d, c: e.c, h: e.h, px: e.px, jump: e.jump, shares, cost: Math.round(cost), r: +r.toFixed(5), why, pnl: +pnl.toFixed(2), bal: +cash.toFixed(2) });
    }
    curve.push([d, +cash.toFixed(2)]);
  }
  const wins = trades.filter(t => t.pnl > 0).length;
  let peak = ACCOUNT.start, dd = 0; for (const [, v] of curve) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  return {
    balance: +cash.toFixed(2), pnl: +(cash - ACCOUNT.start).toFixed(2), ret: +(cash / ACCOUNT.start - 1).toFixed(5),
    n: trades.length, wins, maxDrawdown: +dd.toFixed(5),
    fees: +(trades.reduce((s, t) => s + 2 * COSTS.brokerage + t.cost * ((COSTS.spreadTicks * S.tick(t.px)) / t.px + COSTS.slipPct / 100), 0)).toFixed(2),
    curve, trades: trades.reverse(),
  };
}

export function run(events, barsByKey, now = Date.now()) {
  const ok = events.filter(e => e.st === "ok");
  const first = ok.length ? Math.min(...ok.map(e => e.t)) : S.PAPER_LOCKED;
  return {
    updated: now, account: ACCOUNT, costs: COSTS, liveFrom: S.PAPER_LOCKED, backtestFrom: first,
    wallets: WALLETS.map(w => ({
      key: w.key, name: w.name, desc: w.desc, exit: w.exit,
      live: simulate(ok, barsByKey, w, S.PAPER_LOCKED),
      backtest: simulate(ok, barsByKey, w, first, S.PAPER_LOCKED),
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ev = JSON.parse(fs.readFileSync(path.join(OUT, "events.json"), "utf8")).events;
  const bars = new Map();
  try { for (const ln of zlib.gunzipSync(fs.readFileSync(path.join(OUT, "bars.jsonl.gz"))).toString("utf8").split("\n")) if (ln) { const j = JSON.parse(ln); bars.set(j.k, j); } } catch (e) { console.log("no bars file; bracket exits fall back to the close"); }
  const out = run(ev, bars);
  fs.writeFileSync(path.join(OUT, "wallets.json"), JSON.stringify(out));
  for (const w of out.wallets) console.log(`${w.name.padEnd(22)} live ${w.live.n} trades $${w.live.balance}  |  backtest ${w.backtest.n} trades $${w.backtest.balance} (${(w.backtest.ret * 100).toFixed(1)}%, max drawdown ${(w.backtest.maxDrawdown * 100).toFixed(1)}%)`);
}
