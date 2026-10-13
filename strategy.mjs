// The rule-driven wallet engine, shared by the live tracker (collect.mjs) and the daily replay (tune.mjs),
// so a rule set behaves the same on recorded data as it does live.
//
// A wallet is stepped once per check with one observation per coin:
//   { px, liq, score, rug, fails, oc }   price in USD, liquidity in USD, momentum score, rug score,
//                                        number of failed safety checks (0-10), on-chain status "o" | "p" | "u"
//   { age }                              pool age in hours (or null)
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
  sellBelow: -30,   // sell when the momentum score falls to this or lower
  dip: 0,           // wait for this fall from the high after a coin qualifies, then buy the bounce (0 = buy straight away)
  maxHG: 1000,      // skip coins whose holder count is growing faster than this % per hour (1000 = no limit)
  noBoost: false,   // skip coins that came from DexScreener's paid-promotion lists
  maxAge: 0,        // only buy coins whose pool is younger than this many hours (0 = any age)
  minH1: -1000,     // only buy coins up at least this % in the last hour (-1000 = no minimum)
  maxHold: 0,       // sell after holding this many minutes (0 = no time limit)
  minM5: -1000,     // only buy coins up at least this % in the last 5 minutes (-1000 = no minimum)
  minAge: 0,        // only buy coins at least this many hours old (0 = any age)
  rugMemo: 0,       // skip coins whose rug score was 60 or more at any point in this many minutes (0 = off)
  lossCool: 0,      // after a losing sale, skip that coin for this many minutes (0 = only the usual 1-hour pause)
  mkt: -1000        // only buy while the typical tradeable coin is up at least this % over the hour (-1000 = off)
};

// Rule sets in use since the first day's review (12 Oct 2026). That day's data showed the losses came from
// coins that had already risen a long way, from thinly traded coins, and from holding losers down to a wide stop.
// All three therefore skip coins up more than 50% in 24 hours, use a 12% stop, and sell when the score fades.
const REVIEWED = { maxH24: 50, stop: 0.12, lockAt: 0, halfAt: 0, fade: false };
// Takes a quick, fixed profit instead of waiting for a long run.
export const QUICK = Object.assign({}, DEFAULTS, REVIEWED, { maxH1: 25, maxM5: 10, sizeLo: 5, take: 0.08, trailAt: 0, sellBelow: 15 });
// Only deep, established pools that have not already moved; lets winners run on a 10% trailing stop.
export const STEADY = Object.assign({}, DEFAULTS, REVIEWED, { minLiq: 250000, maxH1: 15, maxM5: 10, trailAt: 0.1, trailDrop: 0.1, sellBelow: 15 });
// Where the adaptive wallet started from 12 Oct (kept for the replay comparison).
export const ADAPTIVE_OLD = Object.assign({}, DEFAULTS, REVIEWED, { minLiq: 250000, maxH1: 25, maxM5: 10, trailAt: 0.1, trailDrop: 0.1, sellBelow: 20 });
// Trades the one lead that was ahead on day one: coins that are down over 24 hours but now being bought.
export const RECOVERY = Object.assign({}, QUICK, { maxH24: 0 });
// Fresh launches (13 Oct 2026): young coins that are already pumping and passed the rug check. About half of young
// pumping coins with a low rug score did not collapse in the next six hours; this wallet tries to take a quick
// gain from those and get out before the fade. Small size, tight stop, fixed take-profit and a time limit.
export const FRESH = Object.assign({}, DEFAULTS, { buyLine: -29, rugMax: 30, maxFails: 10, minLiq: 50000, confirm: false, sizeHi: 2.5, sizeLo: 2.5,
  stop: 0.1, lockAt: 0, trailAt: 0, halfAt: 0, fade: false, maxH1: 1000, maxM5: 1000, maxH24: 100000, take: 0.15, sellBelow: -1000,
  maxAge: 24, minH1: 20, maxHold: 45, rugMemo: 60 });

// The five wallets from 13 Oct 2026 evening. The first two days showed that buying established coins on our
// momentum score lost money under every rule tried, while quick in-and-out trades on young coins that passed the
// rug check came out ahead. So all five now test that one idea from different angles:
//   Fresh launches   the main version (under 24 h old, up 20%+ in the hour), now skipping coins flagged as a rug
//                    risk in the last hour, which removes the "flagged a minute after buying" losses.
//   Brand-new        the earliest entry: under 6 hours old, bought on the first 5-minute jump of 5%+.
//   Strong pumps     the latest entry: only once a coin is up 60%+ in the hour.
//   Day-two coins    the same rules on coins 1 to 3 days old, to see whether the edge lasts past the first day.
//   Adaptive         starts on coins up to 2 days old and retunes itself daily from the recorded data.
export const BRANDNEW = Object.assign({}, FRESH, { minH1: -1000, minM5: 5, maxAge: 6 });
export const STRONG = Object.assign({}, FRESH, { minH1: 60 });
export const DAYTWO = Object.assign({}, FRESH, { minAge: 24, maxAge: 72 });
export const ADAPTIVE_FRESH = Object.assign({}, FRESH, { maxAge: 48 });
export const ADAPTIVE_VERSION = 3;
export const ADAPTIVE_START = ADAPTIVE_FRESH;

// Every wallet is retuned daily from the recorded data. Each keeps the settings that define it ("lock"), so the
// five stay distinct experiments; the adaptive wallet may move any setting. TUNE_VERSION restarts all tuning.
export const TUNE_VERSION = 4;
const LOCK_ENTRY = ["maxAge", "minAge", "minH1", "minM5", "buyLine", "maxH1", "maxM5", "maxH24", "early", "dip", "confirm"];
export const WALLETS = [
  { key: "e", file: "wallet-e.json", name: "Fresh launches", base: FRESH, lock: LOCK_ENTRY, resetKey: "resetIdE", metaKey: "walletE" },
  { key: "a", file: "wallet.json", name: "Brand-new launches", base: BRANDNEW, lock: LOCK_ENTRY, resetKey: "resetId", metaKey: "wallet" },
  { key: "b", file: "wallet-b.json", name: "Strong pumps", base: STRONG, lock: LOCK_ENTRY, resetKey: "resetIdB", metaKey: "walletB" },
  { key: "d", file: "wallet-d.json", name: "Day-two coins", base: DAYTWO, lock: LOCK_ENTRY, resetKey: "resetIdD", metaKey: "walletD" },
  { key: "c", file: "wallet-c.json", name: "Adaptive launches", base: ADAPTIVE_START, lock: [], resetKey: "resetIdC", metaKey: "walletC" }
];
export const baseSig = P => JSON.stringify(Object.keys(P).sort().map(k => [k, P[k]]));
// The rules a wallet is using now: its starting rules plus whatever the daily tuning has adopted since.
export function rulesFor(w, tuning) {
  const t = tuning && tuning.ver === TUNE_VERSION && tuning.wallets && tuning.wallets[w.key];
  return Object.assign({}, w.base, t && t.baseSig === baseSig(w.base) && t.current ? t.current : {});
}

// The values the daily tuning may move between, one step at a time.
export const GRID = {
  buyLine: [30, 35, 40, 50, 60],
  rugMax: [20, 30, 40],
  maxFails: [0, 1, 2],
  minLiq: [25000, 50000, 100000, 250000, 500000],
  confirm: [false, true],
  stop: [0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3],
  lockAt: [0, 0.1, 0.15, 0.25],
  trailAt: [0, 0.05, 0.1, 0.2, 0.3],
  trailDrop: [0.08, 0.1, 0.15, 0.2, 0.3],
  halfAt: [0, 0.3, 0.5, 1],
  fade: [false, true],
  maxH1: [15, 25, 40, 1000],
  maxM5: [5, 10, 1000],
  early: [false, true],
  maxH24: [0, 20, 50, 100, 300, 100000],
  dip: [0, 0.05, 0.08, 0.12],
  maxHG: [0.5, 1, 2, 1000],
  noBoost: [false, true],
  take: [0, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25],
  maxAge: [6, 12, 24, 48, 72],
  minH1: [-1000, 10, 20, 30, 40, 60],
  minM5: [-1000, 3, 5, 8],
  maxHold: [0, 20, 30, 45, 60, 90],
  rugMemo: [0, 60, 120],
  lossCool: [0, 180, 720],
  mkt: [-1000, -1, 0, 1],
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
  maxH24: v => (v >= 100000 ? "no limit on the 24-hour rise" : v <= 0 ? "only buy coins that are down over 24 hours" : "skip coins already up more than " + v + "% in 24 hours"),
  dip: v => (v ? "wait for a " + pc(v) + " pullback after the signal before buying" : "buy as soon as the signal qualifies"),
  maxHG: v => (v >= 1000 ? "no limit on holder growth" : "skip coins whose holder count is growing more than " + v + "% an hour"),
  noBoost: v => (v ? "skip coins from the paid-promotion lists" : "allow coins from the paid-promotion lists"),
  take: v => (v ? "sell everything at " + pc(v) + " up" : "no fixed take-profit"),
  sellBelow: v => (v <= -1000 ? "ignore the score once bought" : "sell when the score falls to " + v + " or lower"),
  maxAge: v => (v ? "only coins under " + v + " hours old" : "coins of any age"),
  minH1: v => (v <= -1000 ? "no minimum rise in the hour" : "only coins up at least " + v + "% in the last hour"),
  maxHold: v => (v ? "sell after " + v + " minutes" : "no time limit on holding"),
  minM5: v => (v <= -1000 ? "no minimum 5-minute move" : "only coins up at least " + v + "% in the last 5 minutes"),
  rugMemo: v => (v ? "skip coins flagged as a rug risk in the last " + v + " minutes" : "no memory of earlier rug flags"),
  lossCool: v => (v ? "no re-buying a coin for " + Math.round(v / 60) + " hours after a loss on it" : "re-buying allowed an hour after a loss"),
  mkt: v => (v <= -1000 ? "trades whatever the market is doing" : "only buys while the typical coin is up at least " + v + "% over the hour")
};

export function describe(P) {
  const caps = [P.maxH24 < 100000 && P.maxH24 > 0 ? P.maxH24 + "% in 24 hours" : "", P.maxH1 < 1000 ? P.maxH1 + "% in the last hour" : "", P.maxM5 < 1000 ? P.maxM5 + "% in the last 5 minutes" : ""].filter(Boolean);
  const sells = ["on a Rug risk or Avoid verdict"].concat(P.sellBelow <= -1000 ? [] : ["when the score falls to " + P.sellBelow + " or lower"], ["at " + pc(P.stop) + " down"]);
  if (P.maxHold) sells.push("after " + P.maxHold + " minutes whatever the price");
  if (P.take) sells.push("at " + pc(P.take) + " up");
  if (P.lockAt) sells.push("at the buy price once it has been " + pc(P.lockAt) + " up");
  if (P.trailAt) sells.push("on a " + pc(P.trailDrop) + " fall from the peak once it has been " + pc(P.trailAt) + " up");
  if (P.fade) sells.push("when the score drops below zero while in profit");
  const ageTxt = P.minAge > 0 && P.maxAge > 0 ? " " + P.minAge + " to " + P.maxAge + " hours old" : P.maxAge > 0 ? " under " + P.maxAge + " hours old" : P.minAge > 0 ? " at least " + P.minAge + " hours old" : "";
  const moves = [P.minH1 > -1000 ? "up at least " + P.minH1 + "% in the last hour" : "", P.minM5 > -1000 ? "up at least " + P.minM5 + "% in the last 5 minutes" : ""].filter(Boolean).join(" and ");
  const entry = (P.buyLine <= -29 ? "Buys coins" + ageTxt + (moves ? " that are " + moves : "")
    : "Buys when the score is " + P.buyLine + " or more" + (ageTxt ? ", the coin is" + ageTxt : "") + (moves ? ", it is " + moves : "")) + ", where the rug score";
  return entry + " is under " + P.rugMax + ", " + (P.maxFails >= 10 ? "the on-chain checks have come back" : P.maxFails === 0 ? "no safety check has failed" : "no more than " + P.maxFails + " safety check" + (P.maxFails === 1 ? " has" : "s have") + " failed") +
    " and liquidity is at least " + usdK(P.minLiq) + (P.confirm && !P.dip ? ", and the signal is still there on the next check" : "") + "." +
    (P.maxH24 <= 0 ? " Only buys coins that are down over the last 24 hours." : "") +
    (P.dip ? " It does not buy straight away: once a coin qualifies it waits up to an hour for a " + pc(P.dip) + " fall from the high, then buys when the price has stopped falling." : "") +
    (P.noBoost ? " Skips coins that came from DexScreener's paid-promotion lists." : "") +
    (P.rugMemo ? " Skips any coin flagged as a rug risk in the last " + (P.rugMemo >= 120 ? P.rugMemo / 60 + " hours" : P.rugMemo === 60 ? "hour" : P.rugMemo + " minutes") + "." : "") +
    (P.lossCool ? " Will not re-buy a coin for " + Math.round(P.lossCool / 60) + " hours after a loss on it." : "") +
    (P.mkt > -1000 ? " Only buys while the typical coin is up at least " + P.mkt + "% over the hour." : "") +
    (P.maxHG < 1000 ? " Skips coins whose holder count is growing more than " + P.maxHG + "% an hour." : "") +
    (caps.length ? " Skips coins already up more than " + caps.join(", or ") + "." : "") +
    (P.early ? " Also buys early, at the smaller size, when at least 60% of the hour's trades are buys, volume is running at 1.5 times its 6-hour average and the price is up less than 10% in the hour." : "") +
    " Puts in " + (P.sizeHi === P.sizeLo ? P.sizeHi + "% of the wallet per buy" : P.sizeHi + "% of the wallet at a score of " + P.hiScore + " or more and " + P.sizeLo + "% below that") + ". " +
    "Sells " + sells.slice(0, -1).join(", ") + ", or " + sells[sells.length - 1] + "." + (P.halfAt ? " Sells half at " + pc(P.halfAt) + " up." : "");
}

export function freshWallet(start, now, extra) {
  return Object.assign({ started: now, start, cash: start, pos: {}, hist: [], eq: [], skipped: 0, pend: {}, cool: {}, watch: {} }, extra || {});
}

const num = x => (typeof x === "number" && isFinite(x)) ? x : 0;
// Verdicts that force an exit, worked out from the same fields the page uses.
const forced = (o, P, p) => p && p.liq0 > 0 && !(o.liq >= p.liq0 * 0.2) ? "Pool pulled" : o.rug >= 60 ? "Rug risk verdict" : (!o.liq || o.liq < 10000) ? "Liquidity fell under $10k" : o.score <= P.sellBelow ? (P.sellBelow <= -30 ? "Sell verdict" : "Score fell to " + o.score) : "";
// A coin cannot be bought while it is in a state that would force a sale.
const blocked = o => o.rug >= 60 || !o.liq || o.liq < 10000 || o.score <= -30;

// Advance one wallet by one check. ctx: { now, solPx, fee, info(a) -> {sym, checks, conf}, confirmMin, confirmMax, countMisses, missMax, keepHist }
export function stepWallet(W, obs, P, ctx) {
  const now = ctx.now, solPx = ctx.solPx, fee = ctx.fee;
  W.pend = W.pend || {}; W.cool = W.cool || {};
  // A pool that has lost more than 80% of the liquidity it had when bought has been pulled: nothing can be sold.
  const sellValue = (qty, o, p) => { if (p && p.liq0 > 0 && !(o.liq >= p.liq0 * 0.2)) return 0; const gross = qty * o.px, imp = o.liq ? gross / (o.liq / 2 + gross) : 1; return gross * (1 - imp) * (1 - fee) / solPx; };
  const sell = (a, frac, why) => {
    const p = W.pos[a], o = obs.get(a), qty = p.qty * frac, costPart = p.cost * frac, out = o && o.px > 0 ? sellValue(qty, o, p) : 0;
    W.cash += out;
    W.hist.unshift({ t: now, side: "sell", sym: p.sym, a, amt: out, px: o && o.px > 0 ? o.px : num(p.px), pnl: out - costPart, cost: costPart, held: now - p.at, why, checks: p.checks, conf: p.conf, buyPx: p.px0, buyT: p.at });
    p.qty -= qty; p.cost -= costPart;
    if (frac >= 1) { delete W.pos[a]; W.cool[a] = now; if (out - costPart < 0 && P.lossCool > 0) { W.lcool = W.lcool || {}; W.lcool[a] = now; } }
  };
  for (const a of Object.keys(W.pos)) {
    const p = W.pos[a], o = obs.get(a), e = p.px0;
    if (!(o && o.px > 0)) {
      if (ctx.countMisses !== false) { p.miss = (p.miss || 0) + 1; if (p.miss >= (ctx.missMax || 20)) sell(a, 1, "No longer priced, written off"); }
      continue;
    }
    p.miss = 0; if (o.px > num(p.hi)) p.hi = o.px;
    let why = forced(o, P, p);
    if (!why && P.take > 0 && o.px >= e * (1 + P.take)) why = "Took profit at " + pc(P.take) + " up";
    if (!why && o.px <= e * (1 - P.stop)) why = "Stop-loss, " + pc(P.stop) + " down";
    if (!why && P.lockAt > 0 && p.hi >= e * (1 + P.lockAt) && o.px <= e) why = "Back to the buy price after being " + pc(P.lockAt) + " up";
    if (!why && P.trailAt > 0 && p.hi >= e * (1 + P.trailAt) && o.px <= p.hi * (1 - P.trailDrop)) why = "Fell " + pc(P.trailDrop) + " from its peak";
    if (!why && P.fade && o.px >= e * 1.02 && o.score < 0) why = "Momentum faded while in profit";
    if (!why && P.maxHold > 0 && now - p.at >= P.maxHold * 60e3) why = "Time limit, " + P.maxHold + " minutes";
    if (why) { sell(a, 1, why); continue; }
    if (P.halfAt > 0 && !p.half && o.px >= e * (1 + P.halfAt)) { sell(a, 0.5, "Took half at " + pc(P.halfAt) + " up"); p.half = true; }
  }
  const holdings = () => { let t = 0; for (const a of Object.keys(W.pos)) { const p = W.pos[a], o = obs.get(a); if (o && o.px > 0) { p.val = sellValue(p.qty, o, p); p.px = o.px; p.now = ctx.verdictOf ? ctx.verdictOf(a) : undefined; } t += num(p.val); } return t; };
  let equity = W.cash + holdings();
  const live = new Set(), cMin = ctx.confirmMin == null ? 60e3 : ctx.confirmMin, cMax = ctx.confirmMax || 6 * 60e3;
  W.watch = W.watch || {};
  if (P.rugMemo > 0) { W.flag = W.flag || {}; for (const [a, o] of obs) if (o.rug >= 60) W.flag[a] = now; for (const a of Object.keys(W.flag)) if (now - W.flag[a] > P.rugMemo * 60e3) delete W.flag[a]; }
  if (P.lossCool > 0) { W.lcool = W.lcool || {}; for (const a of Object.keys(W.lcool)) if (now - W.lcool[a] > P.lossCool * 60e3) delete W.lcool[a]; }
  const mktOk = !(P.mkt > -1000) || (ctx.breadth != null && ctx.breadth >= P.mkt);
  for (const [a, o] of obs) {
    if (!mktOk) break;
    if ((P.rugMemo > 0 && W.flag[a]) || (P.lossCool > 0 && W.lcool[a])) continue;
    // Only buy once the on-chain checks have actually come back ("o"); not while pending or unavailable.
    if (!(o.px > 0) || o.oc !== "o" || blocked(o) || !(o.rug < P.rugMax) || !(o.fails <= P.maxFails)) continue;
    const early = !!P.early && o.score >= 15 && o.bp != null && o.bp >= 0.6 && o.acc != null && o.acc >= 1.5 && num(o.h1) < 10 && num(o.m5) > 0;
    const signal = (o.score >= P.buyLine || early) && !(num(o.h1) > P.maxH1 || num(o.m5) > P.maxM5 || num(o.h24) > P.maxH24)
      && !(P.maxAge > 0 && !(o.age != null && o.age < P.maxAge)) && !(P.minH1 > -1000 && !(num(o.h1) >= P.minH1))
      && !(P.minM5 > -1000 && !(num(o.m5) >= P.minM5)) && !(P.minAge > 0 && !(o.age != null && o.age >= P.minAge));
    if ((P.noBoost && o.src && o.src.includes("b")) || (o.hg != null && o.hg > P.maxHG)) continue;
    let viaDip = false;
    if (P.dip > 0) {
      // Pullback entry: a qualifying coin goes on watch; it is bought on a dip from its high once the fall has stopped.
      if (W.pos[a] || (W.cool[a] && now - W.cool[a] < 3600e3)) continue;
      let w = W.watch[a];
      if (w && now - w.t > 3600e3) { delete W.watch[a]; w = null; }
      if (!w) { if (!(signal && o.liq >= P.minLiq)) continue; W.watch[a] = { t: now, hi: o.px }; continue; }
      if (o.px > w.hi) w.hi = o.px;
      if (!(o.px <= w.hi * (1 - P.dip) && num(o.m5) >= 0 && o.score >= 15 && o.liq >= P.minLiq)) continue;
      delete W.watch[a]; viaDip = true;
    } else {
      if (!signal) continue;
      live.add(a);
      if (W.pos[a] || (W.cool[a] && now - W.cool[a] < 3600e3) || !(o.liq >= P.minLiq)) continue;
      if (P.confirm) {
        const seen = num(W.pend[a]);
        if (!(seen && now - seen <= cMax)) { W.pend[a] = now; continue; }
        if (now - seen < cMin) continue;
        delete W.pend[a];
      }
    }
    const amt = Math.min(equity * (o.score >= P.hiScore && o.score >= P.buyLine ? P.sizeHi : P.sizeLo) / 100, W.cash);
    if (!(amt >= 0.01)) { W.skipped = (W.skipped || 0) + 1; continue; }
    const usdIn = amt * solPx, imp = usdIn / (o.liq / 2 + usdIn), fill = o.px * (1 + imp), qty = (usdIn - amt * fee * solPx) / fill;
    const inf = ctx.info ? ctx.info(a) : { sym: a.slice(0, 4) };
    W.pos[a] = { sym: inf.sym, qty, cost: amt, at: now, px0: fill, liq0: o.liq, hi: o.px, checks: inf.checks, conf: inf.conf, score: o.score };
    W.cash -= amt;
    if (ctx.keepHist !== false) W.hist.unshift({ t: now, side: "buy", sym: inf.sym, a, amt, px: fill, checks: inf.checks, conf: inf.conf, score: o.score, early: early && !(o.score >= P.buyLine) ? 1 : undefined, dip: viaDip ? 1 : undefined });
  }
  for (const a of Object.keys(W.watch)) { if (now - W.watch[a].t > 3600e3) delete W.watch[a]; }
  // A pending confirmation is dropped when the coin was observed and no longer qualifies.
  for (const a of Object.keys(W.pend)) { if (!live.has(a) && (obs.has(a) || now - W.pend[a] > cMax)) delete W.pend[a]; }
  for (const a of Object.keys(W.cool)) { if (now - W.cool[a] > 3600e3) delete W.cool[a]; }
  equity = W.cash + holdings();
  W.equity = equity; W.t = now;
  return equity;
}
