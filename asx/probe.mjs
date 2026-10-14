// One-off check: which free ASX data sources answer from GitHub's servers.
import fs from "node:fs";
const H = { "User-Agent": "Mozilla/5.0 (compatible; research-probe)", Accept: "application/json,text/html,*/*" };
const T = [
  ["anns-markit-all", "https://asx.api.markitdigital.com/asx-research/1.0/markets/announcements?page=0&itemsPerPage=25"],
  ["anns-markit-co", "https://asx.api.markitdigital.com/asx-research/1.0/companies/PLS/announcements?count=20"],
  ["anns-asx-v1", "https://www.asx.com.au/asx/1/company/PLS/announcements?count=20&market_sensitive=false"],
  ["anns-today-html", "https://www.asx.com.au/asx/v2/statistics/todayAnns.do"],
  ["anns-prevday-html", "https://www.asx.com.au/asx/v2/statistics/prevBusDayAnns.do"],
  ["anns-year-html", "https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&asxCode=PLS&timeframe=Y&year=2026"],
  ["companies-csv", "https://www.asx.com.au/asx/research/ASXListedCompanies.csv"],
  ["markit-header", "https://asx.api.markitdigital.com/asx-research/1.0/companies/PLS/header"],
  ["yahoo-1m-5d", "https://query1.finance.yahoo.com/v8/finance/chart/PLS.AX?interval=1m&range=5d"],
  ["yahoo-5m-60d", "https://query1.finance.yahoo.com/v8/finance/chart/PLS.AX?interval=5m&range=60d"],
  ["yahoo-1h-2y", "https://query1.finance.yahoo.com/v8/finance/chart/PLS.AX?interval=1h&range=2y"],
  ["yahoo-1d-5y", "https://query1.finance.yahoo.com/v8/finance/chart/PLS.AX?interval=1d&range=5y"],
  ["yahoo2-5m", "https://query2.finance.yahoo.com/v8/finance/chart/LTR.AX?interval=5m&range=60d"],
  ["stooq-daily", "https://stooq.com/q/d/l/?s=pls.au&i=d"],
  ["markit-chart", "https://asx.api.markitdigital.com/asx-research/1.0/companies/PLS/chart?interval=1m&range=1d"]
];
const out = [];
for (const [k, u] of T) {
  const r = { k, u };
  try {
    const res = await fetch(u, { headers: H, signal: AbortSignal.timeout(20000) });
    const txt = await res.text();
    r.status = res.status; r.bytes = txt.length; r.type = res.headers.get("content-type");
    r.head = txt.slice(0, 700).replace(/\s+/g, " ");
    try { const j = JSON.parse(txt); const c = j.chart && j.chart.result && j.chart.result[0];
      if (c) { const ts = c.timestamp || []; r.points = ts.length; r.first = ts[0] && new Date(ts[0] * 1e3).toISOString(); r.last = ts.length && new Date(ts[ts.length - 1] * 1e3).toISOString(); r.gran = c.meta && c.meta.dataGranularity; } } catch (e) {}
  } catch (e) { r.err = String(e.message || e); }
  out.push(r); console.log(k, r.status || r.err, r.bytes || "", r.points || "");
  await new Promise(s => setTimeout(s, 800));
}
fs.writeFileSync("asx/probe-result.json", JSON.stringify(out, null, 1));
