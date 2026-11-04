import type { Migration } from '../shared/migrate.js';

export const chartMonitorMigrations: Migration[] = [
  {
    id: 3,
    name: 'chart_monitor',
    sql: `
      -- Every signal the monitor has seen on the chart. A row exists only once the signal is
      -- remembered: 'baseline' for what was already on the chart at the first read (never
      -- announced), 'announced' once its Discord message was delivered.
      CREATE TABLE chart_signals (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        symbol text NOT NULL,
        timeframe text NOT NULL,
        signal_key text NOT NULL,
        direction text NOT NULL CHECK (direction IN ('BUY', 'SELL')),
        entry double precision,
        stop double precision NOT NULL,
        target double precision NOT NULL,
        hit text CHECK (hit IN ('SL', 'TP')),
        source text NOT NULL CHECK (source IN ('baseline', 'announced')),
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (symbol, timeframe, signal_key)
      );
      CREATE INDEX chart_signals_lookup_idx ON chart_signals (symbol, timeframe, first_seen_at DESC);

      -- One row per monitored chart: whether the first read happened and the health of recent reads.
      CREATE TABLE chart_monitor_state (
        symbol text NOT NULL,
        timeframe text NOT NULL,
        baselined boolean NOT NULL DEFAULT false,
        failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
        alerted boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (symbol, timeframe)
      );
    `,
  },
  {
    id: 4,
    name: 'chart_monitor_created_at',
    sql: `
      -- Migration 3 is already applied, so it stays as it is. first_seen_at was the creation time of
      -- a signal row; it takes the conventional name instead of getting a duplicate column.
      ALTER TABLE chart_signals RENAME COLUMN first_seen_at TO created_at;
      ALTER TABLE chart_monitor_state ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
    `,
  },
];
