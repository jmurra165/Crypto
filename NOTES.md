# Meme Radar: handover notes

Read this first in any new chat about this project. Last updated 14 Oct 2026 (Brisbane).

Owner: Jaidyn. Everything is a **simulation**; no real wallet is connected. Do not change wallet rules without asking Jaidyn first. Keep the repo public (Actions and Pages are free that way) and never add a payment method or a private key.

## What it is
- **Page:** https://jmurra165.github.io/Crypto/ (`index.html`). Solana meme-coin scanner on DexScreener with momentum and rug scores, a demo wallet, auto wallets, signal outcomes, research and tuning panels.
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

**Next step (not started):**
1. Collect 60 days of price-sensitive announcements from small caps.
2. Line them up with the 5-minute prices.
3. Measure whether the move continues or fades at 30 min, 2 hours and the close, broken down by announcement type, jump size, volume, sector and time of day.
4. Count costs (brokerage plus the bid/ask spread).
5. Run it on GitHub Actions to keep it free.
