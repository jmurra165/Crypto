// The rule-driven wallet engine, shared by the live tracker (collect.mjs) and the daily replay (tune.mjs),
// so a rule set behaves the same on recorded data as it does live.
//
// A wallet is stepped once per check with one observation per coin:
//   { px, liq, score, rug, fails, oc }   price in USD, liquidity in USD, momentum score, rug score,
//                                        number of failed safety checks (0-10), on-chain status "o" | "p" | "u"
//   { h1, m5, bp, acc }                  price change over 1 hour and 5 minutes (%), share of the last hour's
//                                        trades that were buys (0-1 or null), last hour's volume against the
//                                        6-hour average (or null)

export const DEFAULTS = {
  buyLine: 35,      // minimum momentum score to buy
  rugMax: 30,       // rug score must be below this
  maxFails: 1,      // failed safety checks allowed
  minLiq: 50000,    // minimum liquidity, USD
  confirm: true,    // signal must still be there on the next check
  hiScore: 60, sizeHi: 5, sizeLo: 2.5,   // % of wallet value put in above / below the high-score line
  stop: 0.25,       // sell when this far below the buy price
  lockAt: 0.15,     // once this far up, sell if price returns to the buy price (0 = off)
  trailAt: 0.20,    // once this far up, start trailing (0 = off)
  trailDrop: 0.20,  // sell on this fall from the peak while trailing
  halfAt: 0.5,      // sell half when this far up (0 = off)
  fade: true,       // sell when in profit and the score drops below zero
  maxH1: 1000,      // do not buy a coin already up more than this % in the last hour (1000 = no limit)
  maxM5: 1000,      // do not buy a coin up more than this % in the last 5 minutes (1000 = no limit)
  early: false,     // also buy on building trade flow before the price has moved
  maxH24: 100000,   // do not buy a coin already up more than this % in 24 hours (100000 = no limit)
  take: 0,          // sell everything when this far up (0 = off)
  sellBelow: -30    // sell when the momentum score falls to this or lower
};

// Rule sets in use since the first day's review (12 Oct 2026). That day's data showed the losses came from
// coins that had already risen a long way, from thinly traded coins, and from holding losers down to a wide stop.
// All three therefore skip coins up more than 50% in 24 hours, use a 12% stop, and sell when the score fades.
const REVIEWED = { maxH24: 50, stop: 0.12, lockAt: 0, halfAt: 0, fade: false };
// Takes a quick, fixed profit instead of waiting for a long run.
export const QUICK = Object.assign({}, DEFAULTS, REVIEWED, { maxH1: 25, maxM5: 10, sizeLo: 5, take: 0.08, trailAt: 0, sellBelow: 15 });
// Only deep, established pools that have not already moved; lets winners run on a 10% trailing stop.
export const STEADY = Object.assign({}, DEFAULTS, REVIEWED, { minLiq: 250000, maxH1: 15, maxM5: 10, trailAt: 0.1, trailDrop: 0.1, sellBelow: 15 });
// Where the adaptive wallet starts; the daily tuning moves it from here.
export const ADAPTIVE_START = Object.assign({}, DEFAULTS, REVIEWED, { minLiq: 250000, maxH1: 25, maxM5: 10, trailAt: 0.1, trailDrop: 0.1, sellBelow: 20 });
export const ADAPTIVE_VERSION = 2;

// The values the daily tuning may move between, one step at a time.
export const GRID = {
  buyLine: [30, 35, 40, 50, 60],
  rugMax: [20, 30, 40],
  maxFails: [0, 1, 2],
  minLiq: [25000, 50000, 100000, 250000, 500000],
  confirm: [false, true],
  sizeLo: [2.5, 5],
  stop: [0.08, 0.12, 0.15, 0.2, 0.25, 0.3],
  lockAt: [0, 0.1, 0.15, 0.25],
  trailAt: [0, 0.05, 0.1, 0.2, 0.3],
  trailDrop: [0.08, 0.1, 0.15, 0.2, 0.3],
  halfAt: [0, 0.3, 0.5, 1],
  fade: [false, true],
  maxH1: [15, 25, 40, 1000],
  maxM5: [5, 10, 1000],
  early: [false, true],
  maxH24: [50, 100, 300, 100000],
  take: [0, 0.05, 0.08, 0.12, 0.2],
  sellBelow: [-30, 0, 15, 25]
};

const pc = v => Math.round(v * 100) + "%";
const usdK = v => "$" + (v >= 1000 ? Math.round(v / 1000) + "k" : v);

export const LABELS = {
  buyLine: v => "buy at a score of " + v + " or more",
  rugMax: v => "rug score under " + v,
  maxFails: v => (v === 0 ? "no failed safety checks allowed" : "up to " + v + " failed safety check" + (v === 1 ? "" : "s")),
  minLiq: v => "at least " + usdK(v) + " of liquidity",
  confirm: v => (v ? "signal must hold for two checks" : "buy on the first check"),
  sizeLo: v => v + "% of the wallet on weaker signals",
  stop: v => "stop-loss at " + pc(v) + " down",
  lockAt: v => (v ? "break-even lock once " + pc(v) + " up" : "no break-even lock"),
  trailAt: v => (v ? "trailing stop starts " + pc(v) + " up" : "no trailing stop"),
  trailDrop: v => "trailing stop sells on a " + pc(v) + " fall from the peak",
  halfAt: v => (v ? "sell half at " + pc(v) + " up" : "never sell half early"),
  fade: v => (v ? "sell when in profit and the score drops below zero" : "ignore fading score while in profit"),
  maxH1: v => (v >= 1000 ? "no limit on how far a coin has already risen in the hour" : "skip coins already up more than " + v + "% in the last hour"),
  maxM5: v => (v >= 1000 ? "no limit on the 5-minute move" : "skip coins up more than " + v + "% in the last 5 minutes"),
  early: v => (v ? "also buy early on building trade flow" : "no early-flow buys"),
  maxH24: v => (v >= 100000 ? "no limit on the 24-hour rise" : "skip coins already up more than " + v + "% in 24 hours"),
  take: v => (v ? "sell everything at " + pc(v) + " up" : "no fixed take-profit"),
  sellBelow: v => "sell when the score falls to " + v + " or lower"
};

export function describe(P) {
  const caps = [P.maxH24 < 100000 ? P.maxH24 + "% in 24 hours" : "", P.maxH1 < 1000 ? P.maxH1 + "% in the last hour" : "", P.maxM5 < 1000 ? P.maxM5 + "% in the last 5 minutes" : ""].filter(Boolean);
  const sells = ["on a Rug risk or Avoid verdict", "when the score falls to " + P.sellBelow + " or lower", "at " + pc(P.stop) + " down"];
  if (P.take) sells.push("at " + pc(P.take) + " up");
  if (P.lockAt) sells.push("at the buy price once it has been " + pc(P.lockAt) + " up");
  if (P.trailAt) sells.push("on a " + pc(P.trailDrop) + " fall from the peak once it has been " + pc(P.trailAt) + " up");
  if (P.fade) sells.push("when the score drops below zero while in profit");
  return "Buys when the score is " + P.buyLine + " or more, the rug score is under " + P.rugMax + ", " + (P.maxFails === 0 ? "no safety check has failed" : "no more than " + P.maxFails + " safety check" + (P.maxFails === 1 ? " has" : "s have") + " failed") +
    " and liquidity is at least " + usdK(P.minLiq) + (P.confirm ? ", and the signal is still there on the next check" : "") + "." +
    (caps.length ? " Skips coins already up more than " + caps.join(", or ") + "." : "") +
    (P.early ? " Also buys early, at the smaller size, when at least 60% of the hour's trades are buys, volume is running at 1.5 times its 6-hour average and the price is up less than 10% in the hour." : "") +
    " Puts in " + (P.sizeHi === P.sizeLo ? P.sizeHi + "% of the wallet per buy" : P.sizeHi + "% of the wallet at a score of " + P.hiScore + " or more and " + P.sizeLo + "% below that") + ". " +
    "Sells " + sells.slice(0, -1).join(", ") + ", or " + sells[sells.length - 1] + "." + (P.halfAt ? " Sells half at " + pc(P.halfAt) + " up." : "");
}

export function freshWallet(start, now, extra) {
  return Object.assign({ started: now, start, cash: start, pos: {}, hist: [], eq: [], skipped: 0, pend: {}, cool: {} }, extra || {});
}

const num = x => (typeof x === "number" && isFinite(x)) ? x : 0;
// Verdicts that force an exit, worked out from the same fields the page uses.
const forced = (o, P) => o.rug >= 60 ? "Rug risk verdict" : (!o.liq || o.liq < 10000) ? "Liquidity fell under $10k" : o.score <= P.sellBelow ? (P.sellBelow <= -30 ? "Sell verdict" : "Score fell to " + o.score) : "";
// A coin cannot be bought while it is in a state that would force a sale.
const blocked = o => o.rug >= 60 || !o.liq || o.liq < 10000 || o.score <= -30;

// Advance one wallet by one check. ctx: { now, solPx, fee, info(a) -> {sym, checks, conf}, confirmMin, confirmMax, countMisses, missMax, keepHist }
export function stepWallet(W, obs, P, ctx) {
  const now = ctx.now, solPx = ctx.solPx, fee = ctx.fee;
  W.pend = W.pend || {}; W.cool = W.cool || {};
  const sellValue = (qty, o) => { const gross = qty * o.px, imp = o.liq ? gross / (o.liq / 2 + gross) : 1; return gross * (1 - imp) * (1 - fee) / solPx; };
  const sell = (a, frac, why) => {
    const p = W.pos[a], o = obs.get(a), qty = p.qty * frac, costPart = p.cost * frac, out = o && o.px > 0 ? sellValue(qty, o) : 0;
    W.cash += out;
    W.hist.unshift({ t: now, side: "sell", sym: p.sym, a, amt: out, px: o && o.px > 0 ? o.px : num(p.px), pnl: out - costPart, cost: costPart, held: now - p.at, why, checks: p.checks, conf: p.conf, buyPx: p.px0, buyT: p.at });
    p.qty -= qty; p.cost -= costPart;
    if (frac >= 1) { delete W.pos[a]; W.cool[a] = now; }
  };
  for (const a of Object.keys(W.pos)) {
    const p = W.pos[a], o = obs.get(a), e = p.px0;
    if (!(o && o.px > 0)) {
      if (ctx.countMisses !== false) { p.miss = (p.miss || 0) + 1; if (p.miss >= (ctx.missMax || 20)) sell(a, 1, "No longer priced, written off"); }
      continue;
    }
    p.miss = 0; if (o.px > num(p.hi)) p.hi = o.px;
    let why = forced(o, P);
    if (!why && P.take > 0 && o.px >= e * (1 + P.take)) why = "Took profit at " + pc(P.take) + " up";
    if (!why && o.px <= e * (1 - P.stop)) why = "Stop-loss, " + pc(P.stop) + " down";
    if (!why && P.lockAt > 0 && p.hi >= e * (1 + P.lockAt) && o.px <= e) why = "Back to the buy price after being " + pc(P.lockAt) + " up";
    if (!why && P.trailAt > 0 && p.hi >= e * (1 + P.trailAt) && o.px <= p.hi * (1 - P.trailDrop)) why = "Fell " + pc(P.trailDrop) + " from its peak";
    if (!why && P.fade && o.px >= e * 1.02 && o.score < 0) why = "Momentum faded while in profit";
    if (why) { sell(a, 1, why); continue; }
    if (P.halfAt > 0 && !p.half && o.px >= e * (1 + P.halfAt)) { sell(a, 0.5, "Took half at " + pc(P.halfAt) + " up"); p.half = true; }
  }
  const holdings = () => { let t = 0; for (const a of Object.keys(W.pos)) { const p = W.pos[a], o = obs.get(a); if (o && o.px > 0) { p.val = sellValue(p.qty, o); p.px = o.px; p.now = ctx.verdictOf ? ctx.verdictOf(a) : undefined; } t += num(p.val); } return t; };
  let equity = W.cash + holdings();
  const live = new Set(), cMin = ctx.confirmMin == null ? 60e3 : ctx.confirmMin, cMax = ctx.confirmMax || 6 * 60e3;
  for (const [a, o] of obs) {
    const early = !!P.early && o.score >= 15 && o.bp != null && o.bp >= 0.6 && o.acc != null && o.acc >= 1.5 && num(o.h1) < 10 && num(o.m5) > 0;
    if (!(o.px > 0) || o.oc === "p" || blocked(o) || !(o.score >= P.buyLine || early) || !(o.rug < P.rugMax) || !(o.fails <= P.maxFails)) continue;
    if (num(o.h1) > P.maxH1 || num(o.m5) > P.maxM5 || num(o.h24) > P.maxH24) continue;
    live.add(a);
    if (W.pos[a] || (W.cool[a] && now - W.cool[a] < 3600e3) || !(o.liq >= P.minLiq)) continue;
    if (P.confirm) {
      const seen = num(W.pend[a]);
      if (!(seen && now - seen <= cMax)) { W.pend[a] = now; continue; }
      if (now - seen < cMin) continue;
      delete W.pend[a];
    }
    const amt = Math.min(equity * (o.score >= P.hiScore && o.score >= P.buyLine ? P.sizeHi : P.sizeLo) / 100, W.cash);
    if (!(amt >= 0.01)) { W.skipped = (W.skipped || 0) + 1; continue; }
    const usdIn = amt * solPx, imp = usdIn / (o.liq / 2 + usdIn), fill = o.px * (1 + imp), qty = (usdIn - amt * fee * solPx) / fill;
    const inf = ctx.info ? ctx.info(a) : { sym: a.slice(0, 4) };
    W.pos[a] = { sym: inf.sym, qty, cost: amt, at: now, px0: fill, hi: o.px, checks: inf.checks, conf: inf.conf, score: o.score };
    W.cash -= amt;
    if (ctx.keepHist !== false) W.hist.unshift({ t: now, side: "buy", sym: inf.sym, a, amt, px: fill, checks: inf.checks, conf: inf.conf, score: o.score, early: early && !(o.score >= P.buyLine) ? 1 : undefined });
  }
  // A pending confirmation is dropped when the coin was observed and no longer qualifies.
  for (const a of Object.keys(W.pend)) { if (!live.has(a) && (obs.has(a) || now - W.pend[a] > cMax)) delete W.pend[a]; }
  for (const a of Object.keys(W.cool)) { if (now - W.cool[a] > 3600e3) delete W.cool[a]; }
  equity = W.cash + holdings();
  W.equity = equity; W.t = now;
  return equity;
}
