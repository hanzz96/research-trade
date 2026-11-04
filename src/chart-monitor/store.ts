import type { Db } from '../shared/db.js';
import type { ChartSignal } from './signals.js';

/** Health of recent reads, kept so a "monitor is down" notice goes out once, not on every check. */
export interface MonitorHealth {
  /** False until the first successful read, which only records what is already on the chart. */
  baselined: boolean;
  /** Consecutive failed reads, and whether a notice has already been sent for them. */
  failures: number;
  alerted: boolean;
}

/** What the monitor remembers between checks. */
export interface MonitorStore {
  loadHealth(): Promise<MonitorHealth>;
  saveHealth(health: Pick<MonitorHealth, 'failures' | 'alerted'>): Promise<void>;
  /** Keys of every signal already remembered (recorded at the first read or announced). */
  seenKeys(): Promise<Set<string>>;
  /** First successful read: remembers what is on the chart without announcing it. */
  recordBaseline(signals: readonly ChartSignal[]): Promise<void>;
  /** Remembers a signal whose Discord message was delivered. */
  recordAnnounced(signal: ChartSignal): Promise<void>;
}

const INSERT_SIGNAL = `
  INSERT INTO chart_signals
    (symbol, timeframe, signal_key, direction, entry, stop, target, hit, source)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (symbol, timeframe, signal_key) DO NOTHING`;

export class PgMonitorStore implements MonitorStore {
  constructor(
    private readonly db: Db,
    private readonly symbol: string,
    private readonly timeframe: string,
  ) {}

  async loadHealth(): Promise<MonitorHealth> {
    const { rows } = await this.db.query<MonitorHealth>(
      `SELECT baselined, failures, alerted FROM chart_monitor_state
       WHERE symbol = $1 AND timeframe = $2`,
      [this.symbol, this.timeframe],
    );
    return rows[0] ?? { baselined: false, failures: 0, alerted: false };
  }

  async saveHealth({ failures, alerted }: Pick<MonitorHealth, 'failures' | 'alerted'>): Promise<void> {
    await this.db.query(
      `INSERT INTO chart_monitor_state (symbol, timeframe, failures, alerted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (symbol, timeframe)
       DO UPDATE SET failures = EXCLUDED.failures, alerted = EXCLUDED.alerted, updated_at = now()`,
      [this.symbol, this.timeframe, failures, alerted],
    );
  }

  async seenKeys(): Promise<Set<string>> {
    const { rows } = await this.db.query<{ signal_key: string }>(
      'SELECT signal_key FROM chart_signals WHERE symbol = $1 AND timeframe = $2',
      [this.symbol, this.timeframe],
    );
    return new Set(rows.map((row) => row.signal_key));
  }

  async recordBaseline(signals: readonly ChartSignal[]): Promise<void> {
    // One transaction: either the monitor is baselined with everything remembered, or not at all.
    await this.db.transaction(async (tx) => {
      for (const signal of signals) await this.insert(tx, signal, 'baseline');
      await tx.query(
        `INSERT INTO chart_monitor_state (symbol, timeframe, baselined)
         VALUES ($1, $2, true)
         ON CONFLICT (symbol, timeframe) DO UPDATE SET baselined = true, updated_at = now()`,
        [this.symbol, this.timeframe],
      );
    });
  }

  async recordAnnounced(signal: ChartSignal): Promise<void> {
    await this.insert(this.db, signal, 'announced');
  }

  private async insert(db: Db, signal: ChartSignal, source: 'baseline' | 'announced'): Promise<void> {
    await db.query(INSERT_SIGNAL, [
      this.symbol,
      this.timeframe,
      signal.key,
      signal.direction,
      signal.entry,
      signal.stop,
      signal.target,
      signal.hit,
      source,
    ]);
  }
}
