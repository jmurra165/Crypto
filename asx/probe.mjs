// Second probe: how far back the announcement feeds go, page sizes and filters.
import fs from "node:fs";
const H = { "User-Agent": "Mozilla/5.0 (compatible; research-probe)", Accept: "application/json,text/html,*/*" };
const M = "https://asx.api.markitdigital.com/asx-research/1.0";
const out = [];
async function get(k, u, fn) {
  const r = { k, u };
  try {
    const res = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) });
    const txt = await res.text();
    r.status = res.status; r.bytes = txt.length;
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    if (fn) { try { Object.assign(r, fn(j, txt)); } catch (e) { r.fnErr = String(e); } }
    if (res.status !== 200 || (!j && !fn)) r.head = txt.slice(0, 400).replace(/\s+/g, " ");
  } catch (e) { r.err = String(e.message || e); }
  out.push(r); console.log(JSON.stringify(r).slice(0, 300));
  await new Promise(s => setTimeout(s, 600));
}
const items = j => (j && j.data && j.data.items) || [];
const sum = j => { const it = items(j); return { n: it.length, first: it[0] && it[0].date, last: it.length && it[it.length - 1].date, ps: it.filter(x => x.isPriceSensitive).length, keys: Object.keys(j && j.data || {}), meta: JSON.stringify(Object.fromEntries(Object.entries(j && j.data || {}).filter(([k]) => k !== "items"))).slice(0, 400) }; };

await get("mkt-100", `${M}/markets/announcements?page=0&itemsPerPage=100`, j => ({ ...sum(j), sample: JSON.stringify(items(j)[0]) }));
await get("mkt-500", `${M}/markets/announcements?page=0&itemsPerPage=500`, sum);
for (const p of [10, 50, 150, 400, 1000]) await get("mkt-p" + p, `${M}/markets/announcements?page=${p}&itemsPerPage=100`, sum);
for (const f of ["priceSensitiveOnly=true", "isPriceSensitive=true", "marketSensitive=true", "priceSensitive=true"]) await get("mkt-f-" + f, `${M}/markets/announcements?page=0&itemsPerPage=100&${f}`, sum);
for (const f of ["dateFrom=2026-08-20", "startDate=2026-08-20&endDate=2026-08-21", "fromDate=2026-08-20&toDate=2026-08-21"]) await get("mkt-d-" + f, `${M}/markets/announcements?page=0&itemsPerPage=100&${f}`, sum);
for (const c of ["LTR", "BOE", "AR3"]) {
  await get("co-" + c + "-100", `${M}/companies/${c}/announcements?count=100`, sum);
  await get("co-" + c + "-500", `${M}/companies/${c}/announcements?count=500`, sum);
  await get("co-" + c + "-p1", `${M}/companies/${c}/announcements?count=100&page=1`, sum);
  await get("hdr-" + c, `${M}/companies/${c}/header`, j => ({ d: JSON.stringify(j && j.data).slice(0, 500) }));
}
await get("year-html-LTR", "https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&asxCode=LTR&timeframe=Y&year=2026", (j, t) => {
  const rows = t.split(/<tr/i).slice(1);
  const ps = (t.match(/pricesens/gi) || []).length;
  return { rows: rows.length, ps, row1: (rows[1] || "").replace(/\s+/g, " ").slice(0, 900) };
});
await get("yahoo-small-5m", "https://query1.finance.yahoo.com/v8/finance/chart/AR3.AX?interval=5m&range=60d", j => {
  const c = j.chart.result[0]; const q = c.indicators.quote[0]; const ts = c.timestamp;
  const i = ts.length - 1;
  return { points: ts.length, first: new Date(ts[0] * 1e3).toISOString(), lastBars: [i - 2, i - 1, i].map(k => [new Date(ts[k] * 1e3).toISOString(), q.open[k], q.high[k], q.low[k], q.close[k], q.volume[k]]), zeroVol: q.volume.filter(v => !v).length, meta: JSON.stringify(c.meta).slice(0, 300) };
});
fs.writeFileSync("asx/probe-result.json", JSON.stringify(out, null, 1));
