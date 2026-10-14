// ASX announcement review: shared maths for the page and the daily collector.
// Every event is one price-sensitive announcement with what the price did after a realistic entry.
// Returns are long-only (retail can't easily short ASX small caps), measured from the entry price.

export const HORIZONS = [
  { key: "r30", label: "30 min" },
  { key: "r2h", label: "2 hours" },
  { key: "rc", label: "Close" },
];

// ASX price steps: under 10c moves in 0.1c, 10c to $2 in 0.5c, $2 and up in 1c.
export const tick = p => (p < 0.1 ? 0.001 : p < 2 ? 0.005 : 0.01);

export const DEFAULT_COSTS = { parcel: 5000, brokerage: 10, spreadTicks: 2, slipPct: 0.2 };

// Round-trip cost as a fraction: brokerage both sides, the spread in ticks (crossing it on the way in
// and out), and a little extra slippage for thin books.
export function costFrac(ev, c = DEFAULT_COSTS) {
  const p = ev.px > 0 ? ev.px : 1;
  return (2 * c.brokerage) / c.parcel + (c.spreadTicks * tick(p)) / p + c.slipPct / 100;
}

export const CATEGORIES = [
  ["halt", "Trading halt / suspension", /trading halt|suspension|reinstatement|pause in trading|halt lifted/i],
  ["takeover", "Takeover / scheme", /takeover|scheme (booklet|implementation|meeting)|bidder'?s statement|target'?s statement|merger|non-binding (indicative )?(offer|proposal)/i],
  ["raise", "Capital raising", /placement|capital rais|entitlement|share purchase plan|\bSPP\b|raises? \$|cleansing|proposed issue|offer booklet|prospectus|convertible note|underwrit/i],
  ["quarterly", "Quarterly / activities", /quarterly|activities report|cash ?flow report|appendix 4c|appendix 5b/i],
  ["financial", "Financial results / guidance", /half[- ]?year|full[- ]?year|annual report|financial (report|results|statements)|appendix 4[de]|earnings|guidance|trading update|profit|results (announcement|presentation)|\b(1|2)H(FY)?\d{2}\b|\bFY\d{2}\b/i],
  ["resource", "Resource / study", /resource|reserve|JORC|scoping study|feasibility|\bPFS\b|\bDFS\b|\bBFS\b/i],
  ["drilling", "Drilling / exploration", /drill|assay|intercept|grades?\b|mineralis|mineraliz|rock chip|sampling|discovery|g\/t|exploration|prospect|soil|geophysic|tenement|lithium|uranium|gold|copper|rare earth/i],
  ["health", "Clinical / regulatory", /clinical|trial|\bFDA\b|\bTGA\b|patient|phase (1|2|3|i{1,3})\b|regulatory approval|CE mark|510\(k\)|breakthrough/i],
  ["deal", "Contract / deal", /acquisition|acquire|agreement|contract|offtake|partnership|joint venture|\bMOU\b|order|award|licen[cs]e|sale of|divest|binding|term sheet|strategic/i],
  ["other", "Other", /.*/],
];
export const categoryOf = h => (CATEGORIES.find(c => c[2].test(h || "")) || CATEGORIES[CATEGORIES.length - 1])[0];
export const categoryLabel = k => (CATEGORIES.find(c => c[0] === k) || [k, k])[1];

function band(v, edges, labels) { for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i]; return labels[labels.length - 1]; }

// Ways to slice the events. Each returns a label (or null to leave the event out of that table).
export const SLICES = {
  category: { label: "Announcement type", fn: e => categoryLabel(e.cat) },
  jump: { label: "Jump at entry", order: true, fn: e => band(e.jump * 100, [-15, -5, -2, 2, 5, 10, 20, 40], ["Down 15%+", "Down 5–15%", "Down 2–5%", "Flat (±2%)", "Up 2–5%", "Up 5–10%", "Up 10–20%", "Up 20–40%", "Up 40%+"]) },
  relVol: { label: "Volume by entry vs normal day", order: true, fn: e => e.rv == null ? null : band(e.rv, [0.25, 0.5, 1, 2, 5], ["Under 0.25×", "0.25–0.5×", "0.5–1×", "1–2×", "2–5×", "5×+"]) },
  tod: { label: "Time of announcement", order: true, fn: e => ({ pre: "Before the open", am: "10:00–12:00", mid: "12:00–14:00", pm: "14:00–15:30" })[e.tod] },
  cap: { label: "Market cap", order: true, fn: e => !(e.cap > 0) ? null : band(e.cap / 1e6, [20, 50, 150, 500], ["Under $20m", "$20–50m", "$50–150m", "$150–500m", "$500m–2b"]) },
  price: { label: "Share price", order: true, fn: e => band(e.px, [0.02, 0.1, 0.5, 2], ["Under 2c", "2–10c", "10–50c", "50c–$2", "$2+"]) },
  liq: { label: "Traded by entry", order: true, fn: e => band(e.val, [10e3, 50e3, 250e3, 1e6], ["Under $10k", "$10–50k", "$50–250k", "$250k–1m", "$1m+"]) },
  sector: { label: "Sector", fn: e => e.sec || "Unknown" },
};

export const DEFAULT_FILTER = { side: "up", minJump: 5, minVal: 20000, minPx: 0, horizon: "rc", excludeHalt: true };

// Several announcements from one company on one morning share a single entry and the same outcome.
// Count each entry once, labelled by its first announcement that isn't a trading halt.
export function dedupe(events) {
  const best = new Map();
  for (const e of events) {
    const k = `${e.c}|${e.d}|${e.em}`, cur = best.get(k);
    const rank = x => (x.cat === "halt" ? 1 : 0) * 1e15 + x.t;
    if (!cur || rank(e) < rank(cur)) best.set(k, e);
  }
  return events.filter(e => best.get(`${e.c}|${e.d}|${e.em}`) === e);
}

export function filterEvents(events, f = DEFAULT_FILTER) {
  return dedupe(events.filter(e => e.st === "ok")).filter(e => {
    if (e[f.horizon] == null) return false;
    if (f.excludeHalt && e.cat === "halt") return false;
    if (e.val < (f.minVal || 0)) return false;
    if (e.px < (f.minPx || 0)) return false;
    const j = e.jump * 100;
    if (f.side === "up") return j >= f.minJump;
    if (f.side === "down") return j <= -f.minJump;
    return true;
  });
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export const MIN_HALF = 30; // cases in each half before a verdict is given

// Older half vs recent half by time, so a pattern only counts if it holds in both.
export function splitTime(events) {
  if (!events.length) return 0;
  const ts = events.map(e => e.t).sort((a, b) => a - b);
  return ts[ts.length >> 1];
}

export function stats(events, f = DEFAULT_FILTER, c = DEFAULT_COSTS, cut = splitTime(events)) {
  const h = f.horizon;
  const gross = events.map(e => e[h]);
  const net = events.map(e => e[h] - costFrac(e, c));
  const older = events.filter(e => e.t < cut).map(e => e[h] - costFrac(e, c));
  const recent = events.filter(e => e.t >= cut).map(e => e[h] - costFrac(e, c));
  const cont = events.filter(e => Math.sign(e[h]) === Math.sign(e.jump) && e[h] !== 0).length;
  const out = {
    n: events.length,
    gross: mean(gross), net: mean(net), med: median(net),
    hit: events.length ? net.filter(x => x > 0).length / events.length : null,
    cont: events.length ? cont / events.length : null,
    cost: mean(events.map(e => costFrac(e, c))),
    older: mean(older), recent: mean(recent), nOld: older.length, nNew: recent.length,
    byH: Object.fromEntries(HORIZONS.map(H => [H.key, mean(events.filter(e => e[H.key] != null).map(e => e[H.key]))])),
  };
  out.verdict = verdict(out);
  return out;
}

export function verdict(s) {
  if (s.nOld < MIN_HALF || s.nNew < MIN_HALF) return { key: "few", label: "Too few cases" };
  if (s.older > 0 && s.recent > 0) return { key: "edge", label: "Edge in both halves" };
  if (s.gross > 0 && s.net <= 0) return { key: "costs", label: "Eaten by costs" };
  if (s.older > 0 || s.recent > 0) return { key: "mixed", label: "One half only" };
  return { key: "none", label: "No edge" };
}

export function table(events, sliceKey, f = DEFAULT_FILTER, c = DEFAULT_COSTS) {
  const sl = SLICES[sliceKey], groups = new Map(), cut = splitTime(events);
  const order = [];
  for (const e of events) { const k = sl.fn(e); if (k == null) continue; if (!groups.has(k)) { groups.set(k, []); order.push(k); } groups.get(k).push(e); }
  const rows = [...groups.entries()].map(([k, evs]) => ({ key: k, ...stats(evs, f, c, cut) }));
  if (sl.order) {
    // Keep natural band order by sampling labels from a sorted pass of the slice function.
    const rank = new Map(); let i = 0;
    for (const e of [...events].sort((a, b) => sortVal(sliceKey, a) - sortVal(sliceKey, b))) { const k = sl.fn(e); if (k != null && !rank.has(k)) rank.set(k, i++); }
    rows.sort((a, b) => rank.get(a.key) - rank.get(b.key));
  } else rows.sort((a, b) => b.n - a.n);
  return rows;
}
function sortVal(k, e) {
  return { jump: e.jump, relVol: e.rv, tod: { pre: 0, am: 1, mid: 2, pm: 3 }[e.tod], cap: e.cap, price: e.px, liq: e.val }[k] ?? 0;
}

// Continue-or-fade grid: mean gross return at each horizon for each jump band (all sides, same liquidity filter).
export function fadeGrid(events, f = DEFAULT_FILTER) {
  const base = dedupe(events.filter(e => e.st === "ok")).filter(e => !(f.excludeHalt && e.cat === "halt") && e.val >= (f.minVal || 0) && e.px >= (f.minPx || 0));
  const sl = SLICES.jump, g = new Map();
  for (const e of [...base].sort((a, b) => a.jump - b.jump)) { const k = sl.fn(e); if (!g.has(k)) g.set(k, []); g.get(k).push(e); }
  return [...g.entries()].map(([k, evs]) => ({ key: k, n: evs.length, ...Object.fromEntries(HORIZONS.map(H => [H.key, mean(evs.filter(e => e[H.key] != null).map(e => e[H.key]))])) }));
}

// Headline summary for the daily review: every slice under the default filter, both sides.
export function summary(events, c = DEFAULT_COSTS) {
  const out = {};
  for (const side of ["up", "down"]) {
    out[side] = {};
    for (const H of HORIZONS) {
      const f = { ...DEFAULT_FILTER, side, horizon: H.key };
      const evs = filterEvents(events, f);
      out[side][H.key] = { all: stats(evs, f, c), best: Object.keys(SLICES).flatMap(s => table(evs, s, f, c).filter(r => r.verdict.key === "edge").map(r => ({ slice: SLICES[s].label, ...r }))) };
    }
  }
  return out;
}
