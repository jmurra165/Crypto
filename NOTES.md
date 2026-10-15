# Meme Radar: handover notes

Read this first in any new chat about this project. Last updated 15 Oct 2026 (Brisbane).

Owner: Jaidyn. Everything is a **simulation**; no real wallet is connected. Do not change wallet rules without asking Jaidyn first. Keep the repo public (Actions and Pages are free that way) and never add a payment method or a private key.

## What it is
- **Page:** https://jmurra165.github.io/Crypto/ (`index.html`). The ASX side project has its own page at `/asx/` (see the end of these notes). Solana meme-coin scanner on DexScreener with momentum and rug scores, a demo wallet, auto wallets, signal outcomes, research and tuning panels.
- **Tracker:** `collect.mjs`, run by `.github/workflows/track.yml`. It loops about every 45 s for about 50 min, then restarts itself. Results are force-pushed to the **`data` branch** (`wallet*.json`, `signals.json`, `tuning.json`, `research.json`, `launches.json`, `snap/` hourly gzip snapshots, `archive/`). Read the data with `git fetch origin +refs/heads/data:refs/remotes/origin/data` and then `git show origin/data:<file>`.
- **Scoring:** lives in `index.html` between the `/*CORE>*/ ... /*<CORE*/` markers and is shared with the tracker.
- **Rule engine:** `strategy.mjs`. It holds `stepWallet`, the rule sets, `WALLETS` (the registry), `GRID` (the tunable values) and `describe`.
- **Daily tuning:** `tune.mjs`, about 7:30 pm Brisbane, for every wallet except Control.
  - It tries one-step changes and adopts one only if it beats the current rules on older data AND on recent unseen data.
  - It needs 3 days of data and 30 replayed trades.
  - Each wallet keeps its defining entry rules; Adaptive may change anything.
  - Trade size is never tuned.
- **Signal research:** `research.mjs`, daily. It includes entry timing (where in the 3-hour price range a signal buys).
- **Daily review:** a scheduled task at 8 pm Brisbane. It reports results and recommendations only, and never edits anything.
- **Config:** `config.json`.
  - `resetId*` restarts a wallet; the old one is archived.
  - `backfill` replays a wallet from an earlier time using recorded data.

## The six wallets (all started at 10 SOL; replayed from the 13 Oct 8:13 pm restart, live since 14 Oct about 10:30 am)
All wallets use the same base rules:
- 2.5% of the wallet per buy
- sell at +15%, -10% or after 45 min
- rug score under 30
- skip any coin flagged as a rug risk (60+) in the last hour
- a pool that loses 80% of its liquidity counts as a total loss

| Key | File | Name | Buys |
|---|---|---|---|
| e | wallet-e.json | Fresh launches | coins under 24 h old, up 20%+ in the hour |
| f | wallet-f.json | Early entry | the same, but up 10%+ in the hour, and the trade filter is $25 |
| a | wallet.json | Brand-new launches | coins under 6 h old, on the first 5%+ move in 5 min; counts only half the rug score's age points |
| b | wallet-b.json | Strong pumps | coins up 60%+ in the hour |
| c | wallet-c.json | Adaptive launches | coins under 48 h old; may retune anything |
| d | wallet-d.json | Control (no filters) | Fresh rules without the quality filters; never tuned; the yardstick |

**Quality filters (all wallets except Control):**
- Skip pumps where the average trade over the last hour is under $50, which is a sign of bot padding.
- Skip coins already up more than 650% on the day.

## What we learned (evidence, roughly 3 days of data)
- **Established coins on a momentum score lose money.**
  - 84 rule combinations were tested; none made money in both halves of the data, even at a quarter of the trading costs.
  - The score buys late: a typical buy sits 64% of the way up the 3-hour price range, about 19% above the low.
- **Quick in-and-out trades on young coins that pass the rug check are the only thing that has shown an edge.** The edge is small and the sample is small.
- **Never trade rug-flagged coins.**
  - Of young coins with a rug score of 60+, about 74% were pulled or dumped within hours.
  - Replays of trading them lost 12% to 28%, even with 5-minute exits, because a pulled pool is a single transaction you cannot sell into.
- **Rug score age points:**
  - Removing them for Brand-new launches lost 19.5% in the replay.
  - Counting half of them was the best of the four options tried.
- **Things that did not help:**
  - trailing stops instead of a fixed take-profit
  - buying the first dip
  - a market-direction filter
  - coins 1 to 3 days old (Day-two coins was retired)
- **Overnight (10 pm to 6 am Brisbane) trades did worst.** Jaidyn did not want an overnight pause; better buy filters came first.
- **The rug filter blocks most young pumps.** On 14 Oct every young pump was blocked, and two thirds of the new coins that day were pulled or dumped. Expect few trades from the filtered wallets.
- **Real money is still a long way off.** Before even thinking about it:
  - Prove the strategy over 2 to 4 weeks and 100+ trades.
  - Check every simulated trade against real Jupiter quotes.
  - Use a separate small wallet with loss limits, and keep the key out of this repo.
  - Note that the ATO may treat frequent trading as a business.

## Changes on 15 Oct (approved by Jaidyn after the 14 Oct review)
- **Rug score limit can no longer be loosened by tuning.** `GRID.rugMax` is now `[20, 30]` (40 removed), for every tuned wallet including Adaptive. Reason: young coins scoring 30 to 69 were about 94% pulled or dumped, and "rug score under 40" was the tuning's top candidate for Early entry and Strong pumps.
- **Stops gap past -10%.** In the 14 Oct review, 7 of 9 stop-outs lost more than a clean -10% stop would (worst -26.8%, VEILDOGE -18.6% within 3 minutes). Every sell now records `prior` (gain at the previous check) and `exit` (gain at the check that sold, before price impact and fees), so the gap between checks can be measured. Sells before 15 Oct do not have these fields.
- **To recheck at 50+ closed trades:** buys between 11 pm and 8 am Brisbane did worse (1 win in 8 vs 3 in 8 in the daytime on 14 Oct). Too few trades to act on yet.

## Open ideas
- A real-quote check: record a Jupiter quote for every simulated trade, to measure how far the simulation is from reality.
- Wallet-following: find wallets that buy early in coins that later run.
- Possibly loosen specific rug warnings (not the whole limit) once `launches.json` has a few hundred outcomes.

## ASX side project (started 14 Oct)
Idea: day-trade ASX small caps that react to **price-sensitive announcements**.

The data check passed. It ran on GitHub's servers (branch `asx-probe`, results in `asx/probe-result.json`).

Announcement sources:
- All ASX announcements, with exact time, `isPriceSensitive`, headline, type and sector: `https://asx.api.markitdigital.com/asx-research/1.0/markets/announcements?page=0&itemsPerPage=25`
- Announcements for one company: `.../asx-research/1.0/companies/{CODE}/announcements`
- A per-company yearly HTML list: `https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&asxCode={CODE}&timeframe=Y&year=2026`
- The company list CSV: `https://www.asx.com.au/asx/research/ASXListedCompanies.csv`

Price source: `https://query1.finance.yahoo.com/v8/finance/chart/{CODE}.AX?interval=5m&range=60d`

| Interval | History available |
|---|---|
| 1 minute | about 7 days |
| 5 minutes | about 60 days |
| 1 hour | 2 years |
| 1 day | 5+ years |

Yahoo is unofficial, so it is fine for research but not for live trading. Stooq blocked us.

The price-sensitive filter is `&priceSensitiveOnly=true` on the market feed; it caps at 10,000 items (about 3 months). Company headers (`/companies/{CODE}/header`) give market cap and today's bid/ask.

**ASX Radar (built 14 Oct): research only, no trading or wallet.**
- **Page:** https://jmurra165.github.io/Crypto/asx/ (`asx/index.html`). Setup controls (up/down moves, minimum move, sell at 30 min / 2 h / close, liquidity, price, costs) recompute everything in the browser. Shows a continue-or-fade chart, slice tables with verdicts and the trade tape with links to the announcement PDFs.
- **Shared maths:** `asx/stats.js` (cost model, categories, slices, older-vs-recent verdicts). Used by the page and the collector.
- **Collector:** `asx/collect.mjs`, run by `.github/workflows/asx.yml` weekdays about 5 pm Brisbane and on changes to the ASX scripts. Results are force-pushed to the **`asx-data` branch** (`events.json`, `bars.jsonl.gz` event-day 5-min bars kept past Yahoo's 60 days, `headers.json`, `summary.json`, `status.json`). It never touches the crypto `data` branch.
- **Rules:** small caps = ordinary shares up to $2b cap (today's cap). Entry: before 10:00 / after 15:30 / overnight → 10:15 price next session; during the session → close of the first full 5-min bar after release; no trade within 30 min → left out. One trade per company per entry (several same-morning announcements count once). Long only.
- **Default costs:** $5,000 parcel, $10 brokerage each side, 2 price steps of spread round trip (0.1c under 10c, 0.5c to $2, 1c above), 0.2% slippage.

**First results (14 Aug to 14 Oct, 3,084 announcements measured, 2,256 unique entries):**
- No edge anywhere yet. Every setup loses after costs in both halves.
- Up-jumps fade slightly before costs, and bigger jumps fade more (up 10–20%: about -1.4% by the close; up 20–40%: about -2.3%). Only about a third keep moving the same way.
- Costs are the killer on cheap shares: average round trip about 6.6% under the defaults, over 30% under 2c. Above 50c the before-cost moves are near zero.
- Worth watching as data builds (too few cases, not a verdict): shares 20c+ that dropped 15%+ bounced about +1.6% net (21 trades, both halves positive); up-moves with $250k–1m traded by entry about +1.1% net (33 trades).
- About 90% of price-sensitive announcements land before the open.

**Ideas not started:** record live bid/ask at entry (header endpoint) to replace the tick-based spread estimate; a scheduled daily ASX review; add next-day open as a horizon.
