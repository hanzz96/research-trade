import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { extractSignals } from '../../src/chart-monitor/signals.js';
import { PgMonitorStore } from '../../src/chart-monitor/store.js';
import { migrate } from '../../src/migrations.js';
import { PgliteDb } from '../support/pglite-db.js';
import { BUY_A, BUY_B, SELL_C, combine, drawSignal } from './support.js';

const [buyA] = extractSignals(BUY_A);
const [buyB] = extractSignals(BUY_B);
const [sellC] = extractSignals(SELL_C);

describe('PgMonitorStore', () => {
  let db: PgliteDb;
  let store: PgMonitorStore;

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE chart_signals, chart_monitor_state RESTART IDENTITY');
    store = new PgMonitorStore(db, 'XAUUSD', '30');
  });

  const rows = async () =>
    (await db.query<{ signal_key: string; source: string }>(
      'SELECT signal_key, source FROM chart_signals ORDER BY id',
    )).rows;

  it('starts not baselined, with no failures and nothing seen', async () => {
    expect(await store.loadHealth()).toEqual({ baselined: false, failures: 0, alerted: false });
    expect(await store.seenKeys()).toEqual(new Set());
  });

  it('records the baseline without announcing and marks the monitor baselined', async () => {
    await store.recordBaseline(extractSignals(combine(SELL_C, BUY_A)));

    expect((await store.loadHealth()).baselined).toBe(true);
    expect(await rows()).toEqual([
      { signal_key: 'SELL|3961.68|3858.98', source: 'baseline' },
      { signal_key: 'BUY|3911.83|4013.65', source: 'baseline' },
    ]);
    expect(await store.seenKeys()).toEqual(new Set(['SELL|3961.68|3858.98', 'BUY|3911.83|4013.65']));
  });

  it('remembers an announced signal with its levels and keeps the first record on a repeat', async () => {
    await store.recordAnnounced(buyB!);
    await store.recordAnnounced(buyB!);

    const { rows: saved } = await db.query(
      'SELECT symbol, timeframe, direction, entry, stop, target, hit, source FROM chart_signals',
    );
    expect(saved).toEqual([
      {
        symbol: 'XAUUSD',
        timeframe: '30',
        direction: 'BUY',
        entry: 3951.94,
        stop: 3913.52379305,
        target: 4009.56431042,
        hit: 'TP',
        source: 'announced',
      },
    ]);
  });

  it('stamps every row with created_at', async () => {
    await store.recordAnnounced(buyA!);
    await store.saveHealth({ failures: 1, alerted: false });

    const signal = await db.query<{ created_at: Date }>('SELECT created_at FROM chart_signals');
    const state = await db.query<{ created_at: Date; updated_at: Date }>(
      'SELECT created_at, updated_at FROM chart_monitor_state',
    );
    expect(Math.abs(Date.now() - signal.rows[0]!.created_at.getTime())).toBeLessThan(60_000);
    expect(Math.abs(Date.now() - state.rows[0]!.created_at.getTime())).toBeLessThan(60_000);
  });

  it('keeps created_at when the health row is updated later', async () => {
    await store.saveHealth({ failures: 1, alerted: false });
    const before = (await db.query<{ created_at: Date }>('SELECT created_at FROM chart_monitor_state')).rows[0]!;
    await store.saveHealth({ failures: 2, alerted: true });
    const after = (await db.query<{ created_at: Date }>('SELECT created_at FROM chart_monitor_state')).rows[0]!;
    expect(after.created_at).toEqual(before.created_at);
  });

  it('stores a missing entry as null', async () => {
    const [noEntry] = extractSignals(drawSignal({ x: 2, stop: 3900, target: 3990 }));
    await store.recordAnnounced(noEntry!);
    const { rows: saved } = await db.query<{ entry: number | null }>('SELECT entry FROM chart_signals');
    expect(saved[0]?.entry).toBeNull();
  });

  it('keeps charts apart by symbol and timeframe', async () => {
    await store.recordAnnounced(buyA!);
    const otherTimeframe = new PgMonitorStore(db, 'XAUUSD', '15');
    const otherSymbol = new PgMonitorStore(db, 'EURUSD', '30');

    expect(await otherTimeframe.seenKeys()).toEqual(new Set());
    expect(await otherSymbol.seenKeys()).toEqual(new Set());
    await otherTimeframe.recordAnnounced(buyA!);
    expect(await rows()).toHaveLength(2);
  });

  it('saves and loads the health of recent reads', async () => {
    await store.saveHealth({ failures: 2, alerted: true });
    expect(await store.loadHealth()).toEqual({ baselined: false, failures: 2, alerted: true });

    await store.recordBaseline([sellC!]);
    await store.saveHealth({ failures: 0, alerted: false });
    expect(await store.loadHealth()).toEqual({ baselined: true, failures: 0, alerted: false });
  });
});
