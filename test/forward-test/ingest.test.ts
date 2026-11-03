import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestApp } from '../support/helpers.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;

const INGEST_TOKEN = 'ingest-token-0123456789abcdef';
const M15 = 15 * 60_000;

/** Open time (ISO) of a fully closed M15 candle; `barsAgo = 0` is the candle still forming. */
const barTime = (barsAgo: number) =>
  new Date(Math.floor(Date.now() / M15) * M15 - barsAgo * M15).toISOString();

const bar = (barsAgo = 1, overrides: Record<string, unknown> = {}) => ({
  time: barTime(barsAgo),
  open: 3900,
  high: 3903.5,
  low: 3898.2,
  close: 3902.1,
  tick_volume: 812,
  spread_min: 0.2,
  spread_avg: 0.31,
  spread_max: 0.9,
  ...overrides,
});

const batch = (bars: unknown[] = [bar()], overrides: Record<string, unknown> = {}) => ({
  source: 'mt5-fbs',
  symbol: 'XAUUSD',
  timeframe: '15',
  bars,
  ...overrides,
});

const send = (t: TestApp, body: unknown, token: string | null = INGEST_TOKEN) =>
  t.app.inject({
    method: 'POST',
    url: '/ingest/bars',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-ingest-token': token } : {}) },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /ingest/bars', () => {
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

  const barRows = async () =>
    (await h.db.query<{ symbol: string; timeframe: string; spread_avg: number | null }>(
      'SELECT symbol, timeframe, spread_avg FROM bars ORDER BY bar_time',
    )).rows;
  const rejections = async () =>
    (await h.db.query<{ reason: string; detail: string | null }>(
      'SELECT reason, detail FROM webhook_rejections ORDER BY id',
    )).rows;

  describe('accepted candles', () => {
    it('stores a closed candle together with its spread statistics', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const res = await send(t, batch());

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', received: 1, inserted: 1, duplicates: 0 });
      expect(await barRows()).toEqual([{ symbol: 'XAUUSD', timeframe: '15', spread_avg: 0.31 }]);
    });

    it('is idempotent: sending the same candle again stores nothing new', async () => {
      const t = await h.build({ INGEST_TOKEN });
      await send(t, batch());
      const again = await send(t, batch());

      expect(again.json()).toMatchObject({ inserted: 0, duplicates: 1 });
      expect(await barRows()).toHaveLength(1);
    });

    it('fills gaps: a batch with some known candles only inserts the new ones', async () => {
      const t = await h.build({ INGEST_TOKEN });
      await send(t, batch([bar(1)]));
      const res = await send(t, batch([bar(3), bar(2), bar(1)]));

      expect(res.json()).toMatchObject({ received: 3, inserted: 2, duplicates: 1 });
      expect(await barRows()).toHaveLength(3);
    });

    it('accepts the maximum batch even though it exceeds the default body limit', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const bars = Array.from({ length: 500 }, (_, index) => bar(index + 1));
      const res = await send(t, batch(bars));

      expect(JSON.stringify(batch(bars)).length).toBeGreaterThan(16 * 1024);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ received: 500, inserted: 500 });
    });

    it('keeps candles from different sources apart', async () => {
      const t = await h.build({ INGEST_TOKEN });
      await send(t, batch([bar()]));
      const res = await send(t, batch([bar()], { source: 'tradingview' }));

      expect(res.json()).toMatchObject({ inserted: 1 });
      expect(await barRows()).toHaveLength(2);
    });

    it('shows the latest candle per timeframe on /health', async () => {
      const t = await h.build({ INGEST_TOKEN });
      await send(t, batch([bar(2), bar(1)]));
      const health = await t.app.inject({ method: 'GET', url: '/health' });

      expect(health.json().bars).toEqual({ '15': { latest: barTime(1), count: 2 } });
    });
  });

  describe('rejections', () => {
    it('returns 401 without the token or with a wrong one, and stores nothing', async () => {
      const t = await h.build({ INGEST_TOKEN });

      expect((await send(t, batch(), null)).statusCode).toBe(401);
      expect((await send(t, batch(), 'wrong-token-wrong-token')).statusCode).toBe(401);
      expect(await barRows()).toHaveLength(0);
      expect((await rejections()).map((row) => row.reason)).toEqual([
        'ingest_unauthorized',
        'ingest_unauthorized',
      ]);
    });

    it('does not accept the TradingView webhook token as an ingest token', async () => {
      const t = await h.build({ INGEST_TOKEN });
      expect((await send(t, batch(), t.config.WEBHOOK_TOKEN)).statusCode).toBe(401);
    });

    it('returns 400 for a body that is not JSON', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const res = await send(t, 'not json');
      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('ingest_invalid_json');
    });

    it('rejects inconsistent OHLC values', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const res = await send(t, batch([bar(1, { high: 3890 })]));

      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('ingest_invalid_payload');
      expect(await barRows()).toHaveLength(0);
    });

    it('rejects more than 500 candles in one call', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const bars = Array.from({ length: 501 }, (_, index) => bar(index + 1));
      expect((await send(t, batch(bars))).statusCode).toBe(400);
    });

    it('rejects an unsupported symbol and an unsupported timeframe', async () => {
      const t = await h.build({ INGEST_TOKEN });

      expect((await send(t, batch([bar()], { symbol: 'EURUSD' }))).statusCode).toBe(400);
      expect((await send(t, batch([bar()], { timeframe: '240' }))).statusCode).toBe(400);
      expect((await rejections()).map((row) => row.reason)).toEqual([
        'ingest_unsupported_symbol',
        'ingest_unsupported_timeframe',
      ]);
    });

    it('rejects a candle that is not aligned to the timeframe', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const misaligned = new Date(Date.parse(barTime(1)) + 60_000).toISOString();
      const res = await send(t, batch([bar(1, { time: misaligned })]));

      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('ingest_invalid_bar_time');
    });

    it('rejects a candle that is still forming', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const res = await send(t, batch([bar(0)]));

      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.detail).toContain('not closed yet');
    });
  });

  it('does not exist at all when INGEST_TOKEN is not configured', async () => {
    const t = await h.build();
    expect((await send(t, batch())).statusCode).toBe(404);
  });
});
