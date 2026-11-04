# research-trade — XAU/USD Entry Reminder

Alert-only system for XAU/USD. A TradingView indicator (Pine Script v6) detects BUY/SELL candidates
from EMA, RSI and MACD and sends a webhook. This backend validates it, stores it in PostgreSQL and
posts a Discord alert. **It never places orders and has no broker integration.**

```
TradingView (Pine v6) ──HTTPS webhook──▶ ngrok tunnel ──▶ backend (Fastify) ──▶ PostgreSQL
                                                              └──────────────▶ Discord webhook
```

Milestone 1 (this version) covers the signal pipeline only. Trade plan (SL/TP), risk engine, news
filter and Claude commentary come in later milestones; see [docs/PLAN.md](docs/PLAN.md).

## Requirements

- Node.js >= 22.9, npm
- Docker (for the local PostgreSQL)
- ngrok (with a free static domain, so the webhook URL never changes)
- A TradingView plan that allows webhook alerts, and a Discord channel webhook

## Setup

```bash
npm install
./scripts/init-env.sh          # creates .env with a random WEBHOOK_TOKEN and database password
```

Edit `.env` and paste your `DISCORD_WEBHOOK_URL` (Discord: channel settings → Integrations →
Webhooks → Copy Webhook URL). Keep it private.

```bash
docker compose up -d postgres  # local PostgreSQL on 127.0.0.1:5432
npm run dev                    # applies migrations, then listens on 127.0.0.1:3000
```

Check it is alive: `curl http://127.0.0.1:3000/health`

### Public URL

TradingView cannot reach `localhost`, so expose the backend over HTTPS:

```bash
ngrok http --url=<your-static-domain>.ngrok-free.app 3000
```

The webhook URL is then `https://<your-static-domain>.ngrok-free.app/webhook/tradingview`.
The laptop, the backend and the tunnel must all be running for alerts to be processed.

### Send a test signal

```bash
set -a; . ./.env; set +a
curl -sS -X POST http://127.0.0.1:3000/webhook/tradingview \
  -H 'content-type: application/json' \
  -d "{\"version\":\"1.1\",\"token\":\"$WEBHOOK_TOKEN\",\"symbol\":\"XAUUSD\",\"timeframe\":\"15\",
       \"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:00Z)\",\"direction\":\"BUY\",\"price\":3985.25,
       \"indicators\":{\"ema_fast\":3983.4,\"ema_slow\":3980.1,\"rsi\":56.2,\"macd\":1.15,
       \"macd_signal\":0.82,\"macd_histogram\":0.33,\"atr\":2.4},
       \"levels\":{\"swing_low\":3978.5,\"swing_high\":3990},\"htf\":{\"trend\":1}}"
```

A Discord message should appear. Sending the same command again returns `"status":"duplicate"` and
sends nothing.

## TradingView

1. Add `pine/alerts/xauusd_entry_reminder.pine` to your chart (Pine Editor → paste → Save → Add to chart)
   on `OANDA:XAUUSD`, timeframe **M15**. The higher-timeframe filter (H1) only applies when the
   chart is below the higher timeframe.
2. Create **two alerts** (one per condition): *Condition* = this indicator → `BUY candidate`, then
   `SELL candidate`. Set *Trigger* to **Once Per Bar Close**.
3. *Notifications* → enable **Webhook URL** and paste your public URL from above.
4. *Message*: keep the JSON that the indicator proposes, and replace `PASTE_WEBHOOK_TOKEN_HERE` with
   the `WEBHOOK_TOKEN` value from `.env`. The token lives only in the alert, never in the script.

### Rules (defaults, all configurable as indicator inputs)

| | BUY candidate | SELL candidate |
|---|---|---|
| EMA 9 / 21 | fast > slow | fast < slow |
| RSI 14 | >= 55 | <= 45 |
| MACD 12/26/9 | line > signal | line < signal |
| H1 EMA trend | bullish (last closed H1 bar) | bearish |

**Entry helper.** On each signal the indicator draws the entry (grey dotted), stop (red dashed) and
target (green dashed) lines until price touches one. Each level has its own label: a red `SL` label with
the USD risk at the chosen size (default 1 oz = 0.01 lot; flagged when it exceeds the risk budget input)
and a green `TP` label with the USD reward. The label of the level that was touched gets `> HIT`.
Stop = swing low/high of the last 10 candles +/- 0.5 x ATR, target = 1.5 x the stop distance. The
same levels go into the alert as `plan.stop` / `plan.target` (optional in the payload) and appear in
the Discord message. If you created alerts earlier, recreate them to pick up the new message.

An alert fires only on the **first confirmed candle** where all conditions become true, then stays
quiet for a cooldown (4 bars). Without this, a trend would alert on every candle. These parameters
are research defaults, not validated trading advice.

## How the backend behaves

- Accepts only JSON with the shared token (constant-time check). Optional `ALLOWED_IPS` allowlist.
- Rejects invalid, unsupported, stale (> `MAX_SIGNAL_AGE_MINUTES`) or future-dated payloads, and
  records the reason in `webhook_rejections` (never the token).
- Dedupes on `symbol + timeframe + candle time + direction`, built by the backend.
- Replies `200` as soon as the signal is stored; Discord delivery happens in the background with
  bounded retries. Status flow: `RECEIVED → PROCESSING → SENT | FAILED`.
- On restart, unfinished signals are re-sent. Delivery is therefore at-least-once: a crash between
  the Discord call and the status update can repeat one message, but never drops a signal.
- If `DISCORD_WEBHOOK_URL` is empty, signals are still stored and marked `FAILED` with a clear reason.

## Forward test data (MT5 → database)

A second feature collects real broker candles (with the real spread) so strategies can be paper
traded and backtested on FBS data instead of TradingView's. Stage 1, the backend, is ready:

- `POST /ingest/bars` takes up to 500 **closed** candles per call, authenticated with the
  `X-Ingest-Token` header (`INGEST_TOKEN` in `.env`; the endpoint is disabled when it is empty).
  Candles are idempotent per source, symbol, timeframe and open time, so re-sending is safe.
- `GET /health` shows the latest candle and the candle count per timeframe.

```bash
set -a; . ./.env; set +a
curl -sS -X POST http://127.0.0.1:3000/ingest/bars \
  -H 'content-type: application/json' -H "x-ingest-token: $INGEST_TOKEN" \
  -d '{"source":"mt5-fbs","symbol":"XAUUSD","timeframe":"15","bars":[
        {"time":"2026-11-03T08:30:00Z","open":3900,"high":3903.5,"low":3898.2,"close":3902.1,
         "tick_volume":812,"spread_min":0.2,"spread_avg":0.31,"spread_max":0.9}]}'
```

`time` is the candle open time in UTC and spreads are in price units (USD for XAUUSD).
Next stages: the MT5 Expert Advisor that sends candles (`mt5/`), a CSV import for history, then
the strategy engine and paper-trade tracker. See [docs/PLAN.md](docs/PLAN.md).

## Chart monitor (TradingView → Discord without webhook alerts)

TradingView only sends webhooks on a paid plan. As an alternative, `src/chart-monitor/` is a small
separate process that reads the signals the indicator draws on the **TradingView Desktop** chart and
posts new ones to Discord. It needs no server and no database; only `DISCORD_WEBHOOK_URL` in `.env`.

1. Start TradingView Desktop with the debug port, for example
   `/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222`.
2. Keep one chart on `XAUUSD`, **M30**, with the *XAUUSD Entry Reminder* indicator and its
   "Draw entry, stop and target on a signal" input on (the monitor reads those drawings).
3. Run `npm run monitor`. It checks one minute after every M30 candle close (`:01` and `:31`) and
   keeps running until stopped. `npm run monitor:once` does a single check and exits (exit code 1 on
   failure), for cron or launchd.

How it behaves:

- The first successful read only records the signals already on the chart; nothing old is announced.
- A signal is remembered only after its Discord message was delivered, so a failed send is retried
  at the next check. Memory lives in `.monitor-state.json` (git-ignored).
- If the chart cannot be read twice in a row (TradingView closed, other symbol or timeframe, indicator
  removed) it posts one notice to Discord, and one more when it recovers.
- It reads TradingView's internal chart model, so a TradingView update can break it; the tests cover
  the logic but not that part, so check it after updating TradingView.
- It only works while TradingView Desktop and the Mac are on. It is a convenience, not a guarantee;
  for something durable use the webhook pipeline above.
- Do not run it together with another watcher on the same Discord channel, or every signal is posted twice.

## Project structure

One folder per feature; shared code in `shared/`. Conventions are in [CLAUDE.md](CLAUDE.md).

```
src/alerts/        TradingView webhook -> Discord
src/forward-test/  MT5 candles -> Postgres -> paper trading
src/chart-monitor/ TradingView Desktop chart -> Discord (own process, own entry: main.ts)
src/shared/        config, db, auth, migration runner, rejection log, Discord notifier, display helpers
src/server.ts      HTTP app wiring        src/migrations.ts  all migrations, one history
test/              mirrors src/ (alerts/, forward-test/, chart-monitor/, shared/) + support/ harness
pine/alerts/       indicators for TradingView alerts (committed)
pine/backtest/     local backtest strategies (git-ignored)
```

## Development

```bash
npm test          # vitest; uses PGlite (in-process PostgreSQL), no database needed
npm run typecheck
npm run build && npm start
```

## Security notes

- Never commit `.env`; it is git-ignored. `scripts/init-env.sh` generates local secrets.
- Anyone with your Discord webhook URL can post to the channel; rotate it if it leaks.
- The database port is bound to `127.0.0.1` only.

## Disclaimer

Alert and decision-support tool only. Prices come from TradingView and can differ from your broker.
Verify price, spread and every parameter before any trading decision. No profit is guaranteed.
