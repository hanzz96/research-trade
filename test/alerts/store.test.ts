import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/helpers.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;

const newSignal = (idempotencyKey: string) => ({
  idempotencyKey,
  symbol: 'XAUUSD',
  timeframe: '15',
  direction: 'BUY' as const,
  candleTimestamp: '2026-11-02T10:15:00.000Z',
  snapshot: {
    price: 3985.25,
    indicators: {
      ema_fast: 3983.4, ema_slow: 3980.1, rsi: 56.2, macd: 1.15, macd_signal: 0.82,
      macd_histogram: 0.33, atr: 2.4,
    },
    levels: { swing_low: 3978.5, swing_high: 3990 },
    htf: { trend: 1 as const },
  },
});

describe('SignalStore and migrations', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it('round-trips a signal including its JSON snapshot and ISO timestamps', async () => {
    const { id } = await h.store.insert(newSignal('a'));
    const signal = await h.store.get(id);
    expect(signal).toMatchObject({
      id,
      symbol: 'XAUUSD',
      direction: 'BUY',
      candleTimestamp: '2026-11-02T10:15:00.000Z',
      status: 'RECEIVED',
      snapshot: { price: 3985.25, htf: { trend: 1 } },
    });
  });

  it('reports a duplicate for a repeated idempotency key', async () => {
    const first = await h.store.insert(newSignal('same'));
    const second = await h.store.insert(newSignal('same'));
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ id: first.id, duplicate: true });
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const { id } = await h.store.insert(newSignal('claim'));
    const results = await Promise.all([h.store.claim(id), h.store.claim(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rejects an invalid status at the database level', async () => {
    const { id } = await h.store.insert(newSignal('check'));
    await expect(
      h.db.query("UPDATE signals SET status = 'APPROVED' WHERE id = $1", [id]),
    ).rejects.toThrow();
  });

  it('rolls back markSent atomically when the delivery insert fails', async () => {
    const { id } = await h.store.insert(newSignal('tx'));
    await h.store.claim(id);
    // Foreign key violation inside the transaction: the status update must not stick.
    await expect(h.store.markSent(id + 999, 1)).rejects.toThrow();
    expect((await h.store.get(id))?.status).toBe('PROCESSING');
  });
});
