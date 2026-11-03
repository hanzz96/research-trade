import type { Db } from './db.js';
import type { Direction, SignalSnapshot } from './payload.js';

export type SignalStatus = 'RECEIVED' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface NewSignal {
  idempotencyKey: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  candleTimestamp: string;
  snapshot: SignalSnapshot;
}

export interface SignalRecord {
  id: number;
  idempotencyKey: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  candleTimestamp: string;
  snapshot: SignalSnapshot;
  receivedAt: string;
  status: SignalStatus;
  error: string | null;
}

interface SignalRow {
  id: number;
  idempotency_key: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  candle_timestamp: Date | string;
  indicator_snapshot: SignalSnapshot;
  received_at: Date | string;
  status: SignalStatus;
  error: string | null;
}

const toIso = (value: Date | string): string => new Date(value).toISOString();

const toRecord = (row: SignalRow): SignalRecord => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  symbol: row.symbol,
  timeframe: row.timeframe,
  direction: row.direction,
  candleTimestamp: toIso(row.candle_timestamp),
  snapshot: row.indicator_snapshot,
  receivedAt: toIso(row.received_at),
  status: row.status,
  error: row.error,
});

export class SignalStore {
  constructor(private readonly db: Db) {}

  /** Inserts the signal, or reports the existing one when the idempotency key was already seen. */
  async insert(signal: NewSignal): Promise<{ id: number; duplicate: boolean }> {
    const inserted = await this.db.query<{ id: number }>(
      `INSERT INTO signals
         (idempotency_key, symbol, timeframe, direction, candle_timestamp, indicator_snapshot, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'RECEIVED')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        signal.idempotencyKey,
        signal.symbol,
        signal.timeframe,
        signal.direction,
        signal.candleTimestamp,
        JSON.stringify(signal.snapshot),
      ],
    );
    const created = inserted.rows[0];
    if (created) return { id: created.id, duplicate: false };

    const existing = await this.db.query<{ id: number }>(
      'SELECT id FROM signals WHERE idempotency_key = $1',
      [signal.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('signal vanished between insert conflict and lookup');
    return { id: row.id, duplicate: true };
  }

  async get(id: number): Promise<SignalRecord | null> {
    const { rows } = await this.db.query<SignalRow>('SELECT * FROM signals WHERE id = $1', [id]);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /** Atomically moves RECEIVED -> PROCESSING. Returns false if someone else already claimed it. */
  async claim(id: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE signals SET status = 'PROCESSING', updated_at = now()
       WHERE id = $1 AND status = 'RECEIVED'
       RETURNING id`,
      [id],
    );
    return result.rows.length === 1;
  }

  async markSent(id: number, attempts: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE signals SET status = 'SENT', error = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      await tx.query(
        `INSERT INTO alert_deliveries
           (signal_id, destination, category, status, attempt_count, delivered_at)
         VALUES ($1, 'discord', 'trading', 'SENT', $2, now())`,
        [id, attempts],
      );
    });
  }

  async markFailed(id: number, attempts: number, error: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE signals SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1`,
        [id, error],
      );
      await tx.query(
        `INSERT INTO alert_deliveries
           (signal_id, destination, category, status, attempt_count, error_message)
         VALUES ($1, 'discord', 'trading', 'FAILED', $2, $3)`,
        [id, attempts, error],
      );
    });
  }

  /**
   * Startup recovery: anything left in PROCESSING by a crash goes back to RECEIVED.
   * Delivery is therefore at-least-once: a crash between the Discord call and markSent
   * can produce one repeated message, but a signal is never silently dropped.
   */
  async recoverPending(): Promise<number[]> {
    await this.db.query(
      `UPDATE signals SET status = 'RECEIVED', updated_at = now() WHERE status = 'PROCESSING'`,
    );
    const { rows } = await this.db.query<{ id: number }>(
      `SELECT id FROM signals WHERE status = 'RECEIVED' ORDER BY id`,
    );
    return rows.map((row) => row.id);
  }

  async recordRejection(reason: string, detail?: string): Promise<void> {
    await this.db.query('INSERT INTO webhook_rejections (reason, detail) VALUES ($1, $2)', [
      reason,
      detail ?? null,
    ]);
  }

  async stats(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ status: string; count: number }>(
      'SELECT status, count(*)::int AS count FROM signals GROUP BY status',
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}
