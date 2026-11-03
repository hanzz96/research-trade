import type { Db } from './db.js';

interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
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

export async function migrate(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await db.query<{ id: number }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
        migration.id,
        migration.name,
      ]);
    });
  }
}
