import moment from 'moment-timezone';
import { z } from 'zod';
import type { Db } from '../shared/db.js';
import { toIsoString } from '../shared/time.js';

const price = z.number().positive();
const spread = z.number().nonnegative().optional();

/**
 * One closed candle sent by the data source (the MT5 Expert Advisor).
 * `time` is the candle OPEN time in UTC. Spreads are in price units (USD for XAUUSD),
 * i.e. points x point size, summarised over the candle.
 */
export const barSchema = z
  .object({
    time: z.iso.datetime(),
    open: price,
    high: price,
    low: price,
    close: price,
    tick_volume: z.number().int().nonnegative().optional(),
    spread_min: spread,
    spread_avg: spread,
    spread_max: spread,
  })
  .refine(
    (bar) =>
      bar.high >= bar.low &&
      bar.high >= Math.max(bar.open, bar.close) &&
      bar.low <= Math.min(bar.open, bar.close),
    'inconsistent OHLC values',
  );

export const MAX_BARS_PER_BATCH = 500;

export const ingestSchema = z.object({
  source: z.string().trim().min(1).max(32),
  symbol: z.string().trim().min(1).max(32),
  timeframe: z.string().regex(/^[0-9]{1,4}$/, 'timeframe must be minutes, e.g. "15"'),
  bars: z.array(barSchema).min(1).max(MAX_BARS_PER_BATCH),
});

export type IngestBatch = z.infer<typeof ingestSchema>;

const SKEW_MS = 60_000;

/** Rejects candles that are not aligned to the timeframe or are not closed yet. */
export function findBarTimeProblem(batch: IngestBatch, now: number = moment().valueOf()): string | null {
  const minutes = Number(batch.timeframe);
  const length = minutes * 60_000;
  for (const [index, bar] of batch.bars.entries()) {
    const open = moment.utc(bar.time);
    // Intraday candles start on UTC multiples of the timeframe. Longer ones depend on the
    // broker's server-time day boundary, so they are not checked.
    if (minutes <= 60 && (open.valueOf() / 60_000) % minutes !== 0) {
      return `bars.${index}.time: not aligned to the ${minutes}-minute timeframe`;
    }
    if (open.clone().add(length, 'milliseconds').isAfter(moment(now).add(SKEW_MS, 'milliseconds'))) {
      return `bars.${index}.time: candle is not closed yet`;
    }
  }
  return null;
}

export class BarStore {
  constructor(private readonly db: Db) {}

  /** Inserts the candles in one transaction; candles already stored are skipped. */
  async insertMany(batch: IngestBatch): Promise<{ inserted: number }> {
    return this.db.transaction(async (tx) => {
      let inserted = 0;
      for (const bar of batch.bars) {
        const result = await tx.query(
          `INSERT INTO bars
             (source, symbol, timeframe, bar_time, open, high, low, close,
              tick_volume, spread_min, spread_avg, spread_max)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source, symbol, timeframe, bar_time) DO NOTHING
           RETURNING id`,
          [
            batch.source,
            batch.symbol.toUpperCase(),
            batch.timeframe,
            bar.time,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.tick_volume ?? null,
            bar.spread_min ?? null,
            bar.spread_avg ?? null,
            bar.spread_max ?? null,
          ],
        );
        inserted += result.rows.length;
      }
      return { inserted };
    });
  }

  /** Latest candle time and row count per timeframe, for quick daily checks. */
  async latestByTimeframe(): Promise<Record<string, { latest: string; count: number }>> {
    const { rows } = await this.db.query<{ timeframe: string; latest: Date | string; count: number }>(
      `SELECT timeframe, max(bar_time) AS latest, count(*)::int AS count
       FROM bars GROUP BY timeframe ORDER BY timeframe`,
    );
    return Object.fromEntries(
      rows.map((row) => [
        row.timeframe,
        { latest: toIsoString(row.latest), count: row.count },
      ]),
    );
  }
}
