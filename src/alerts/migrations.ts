import type { Migration } from '../shared/migrate.js';

export const alertsMigrations: Migration[] = [
  {
    id: 1,
    name: 'init_signals_deliveries_rejections',
    sql: `
      CREATE TABLE signals (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        idempotency_key text NOT NULL UNIQUE,
        symbol text NOT NULL,
        timeframe text NOT NULL,
        direction text NOT NULL CHECK (direction IN ('BUY', 'SELL')),
        candle_timestamp timestamptz NOT NULL,
        indicator_snapshot jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL CHECK (status IN ('RECEIVED', 'PROCESSING', 'SENT', 'FAILED')),
        error text
      );
      CREATE INDEX signals_status_idx ON signals (status);

      CREATE TABLE alert_deliveries (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        signal_id integer NOT NULL REFERENCES signals (id),
        destination text NOT NULL,
        category text NOT NULL,
        status text NOT NULL CHECK (status IN ('SENT', 'FAILED')),
        attempt_count integer NOT NULL,
        delivered_at timestamptz,
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX alert_deliveries_signal_idx ON alert_deliveries (signal_id);

      CREATE TABLE webhook_rejections (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        received_at timestamptz NOT NULL DEFAULT now(),
        reason text NOT NULL,
        detail text
      );
    `,
  },
];
