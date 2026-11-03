import type { Migration } from '../shared/migrate.js';

export const forwardTestMigrations: Migration[] = [
  {
    id: 2,
    name: 'bars_for_forward_test',
    sql: `
      CREATE TABLE bars (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source text NOT NULL,
        symbol text NOT NULL,
        timeframe text NOT NULL,
        bar_time timestamptz NOT NULL,
        open double precision NOT NULL,
        high double precision NOT NULL,
        low double precision NOT NULL,
        close double precision NOT NULL,
        tick_volume integer,
        spread_min double precision,
        spread_avg double precision,
        spread_max double precision,
        received_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source, symbol, timeframe, bar_time)
      );
      CREATE INDEX bars_lookup_idx ON bars (symbol, timeframe, bar_time DESC);
    `,
  },
];
