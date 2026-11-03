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

1. Add `pine/xauusd_entry_reminder.pine` to your chart (Pine Editor → paste → Save → Add to chart)
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
