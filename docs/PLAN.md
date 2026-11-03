# Implementation plan

Source: PRD v3.0 (XAU/USD Entry Reminder) plus the decisions below. Alert-only: no order execution,
no broker integration.

## Decisions

| Topic | Decision |
|---|---|
| Database | **PostgreSQL** (PRD v3 said SQLite; changed on request). Local via docker-compose, tests via PGlite. |
| Symbol / timeframe | `OANDA:XAUUSD`, trigger M15, trend filter H1 |
| Rules | EMA 9/21, RSI 14 with BUY >= 55 / SELL <= 45, MACD 12/26/9 line vs signal, confirmed candle close only |
| Trigger style | Edge-trigger (first candle where all conditions become true) + 4-bar cooldown |
| Webhook auth | Shared token in the JSON body (TradingView cannot send custom headers) + optional IP allowlist |
| Dedupe key | Built by the backend: symbol + timeframe + candle time + direction |
| Discord | Rule-based alert is sent immediately; Claude commentary (M5) follows as a separate step |
| Payload | v1.1: adds `atr`, `swing_low`, `swing_high`, `htf.trend` so SL/TP can be computed in the backend |
| Position data | Manual trade journal for open risk and daily P/L (no broker access) |
| Risk limits | Kept as in PRD: 0.5% per trade, 1.5% daily loss, 1.0% open risk, USD 250 equity. Configurable. |
| News data | Separate Python/Selenium scraper project (modelled on `fizahkhalid/forex_factory_calendar_news_scraper`, MIT) writing JSON that the backend reads through a swappable provider interface |

## Broker (FBS, MT5) — XAUUSD specification received

Contract size 100, tick size 0.01, min volume 0.01, volume step 0.01, max volume 500, stops level 0,
floating spread, margin/profit currency USD.

- MT5 showed tick value `0` (market closed or no quote). With contract 100 and USD profit currency,
  one 0.01 tick for 1 lot is USD 1; the risk engine will use contract size x tick size and keep the
  reported tick value as a cross-check. Re-check the specification while the market is open.
- Still needed: account currency, account type, commission, broker server time zone (for the daily
  reset), typical spread.
- **Consequence of the current limits:** at 0.01 lot, a USD 1 move costs about USD 1. With a USD 1.25
  risk budget the stop can be at most about USD 1.25 away; at 0.02 lot only about USD 0.63. Stops
  from swing + ATR on M15 are usually larger, so most signals will end as `NO_TRADE`. The limits are
  left as specified and live in configuration; `NO_TRADE` alerts will show the risk a 0.01-lot trade
  would carry so the limits can be revisited with real data.

## Milestones

| # | Scope | Status |
|---|---|---|
| **M1** | Scaffold, Pine indicator (payload v1.1), webhook (auth, validation, dedupe), PostgreSQL, Discord, tests, docs | Backend done (52 tests passing). Pine script compiles; installing it on the chart and a live end-to-end check are pending. |
| **M2** | Strategy engine and trade plan: entry zone, SL (swing + ATR), TP1/TP2, expiry, `WAIT`/`EXPIRED`. Pine `strategy()` version for backtesting. | Not started |
| **M3** | Risk engine: sizing, lot rounding down, daily/open risk, trade journal, `NEEDS_INPUT`/`NO_TRADE`/`APPROVED` | Not started. Needs the remaining broker details above. |
| **M4** | Calendar provider + news engine: sync, T-30/15/5/post reminders, `NEWS_WARNING`/`NEWS_RISK`, stale data handling | Not started. Scraper project first. |
| **M5** | Claude commentary: explanation only, structured output validated, never alters strategy or risk results | Not started |
| **M6** | Reliability and audit: recovery, retries, health alerts | Partly covered in M1 (recovery, retry, status tracking) |
| **M7** | End-to-end testing and paper trading (several weeks) | Not started |

Order: M1 → M2 → M3, with M4 able to run in parallel. Gate before M3: review backtest results from M2;
if the rule set shows no value, change the rules before building more on top.

## Open items

- Install the indicator on the chart, create the two alerts, run a live signal end to end (needs the
  public tunnel URL and the Discord webhook).
- Rest of the broker specification (see above).
- Calendar scraper project: low request frequency, honest user agent, no attempt to bypass bot
  protection; on failure the system reports `NEWS_DATA_UNVERIFIED` instead of assuming no news.
- Evaluate a read-only MT5 integration later (the official Python API is Windows-only; any
  integration must expose no order functions).
- Update the PRD where it still says SQLite (sections 3.3 and 11).
