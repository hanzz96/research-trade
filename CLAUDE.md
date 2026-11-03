# research-trade

Alert-only XAU/USD tooling: no order execution and no broker credentials, ever.
See `README.md` for how to run it and `docs/PLAN.md` for decisions and milestones.

## Layout: one folder per feature

```
src/
  alerts/        TradingView webhook -> Discord (webhook route, signal store, delivery)
  forward-test/  MT5 bars -> Postgres -> paper signals and results (ingest route, bar store;
                 the strategy engine and paper-trade tracker will live here)
  shared/        config, db access, auth, migration runner, rejection log
  server.ts      builds the HTTP app and registers each feature's routes (wiring only)
  index.ts       process bootstrap (wiring only)
  migrations.ts  collects every feature's migrations into one ordered history
test/            mirrors src/ (alerts/, forward-test/, shared/) plus support/ for the harness
pine/alerts/     TradingView indicators used for alerts (committed)
pine/backtest/   local strategy scripts for backtesting (git-ignored)
mt5/             MetaTrader 5 Expert Advisors in MQL5 (data sender, no order functions)
```

## Conventions

- A new feature gets its own folder under `src/` and `test/`, with its own `routes.ts` and
  `migrations.ts`. Register it only in `server.ts` and `src/migrations.ts`.
- Features may import from `shared/`, never from each other. Shared code lives in `shared/`.
- Migrations are append-only, ids are unique across all features, and applied ones are never edited.
- Secrets live only in `.env` (git-ignored). Never log tokens or webhook URLs.
- Tidy as you go: put new code in the right folder, update the layout notes here and in
  `README.md`, and run `npm run typecheck && npm test` before finishing.
