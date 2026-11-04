import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, sendBars, sendSignal } from '../../src/webhook-cli/client.js';
import { createHarness, TOKEN } from '../support/helpers.js';
import { fetchThrough } from './support.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;

const INGEST_TOKEN = 'ingest-token-0123456789abcdef';

const signalOptions = {
  baseUrl: 'http://server.test',
  token: TOKEN,
  symbol: 'XAUUSD',
  timeframe: '15',
  direction: 'BUY' as const,
  price: 3985.25,
  ageMinutes: 5,
  plan: true,
  twice: false,
};

const barsOptions = {
  baseUrl: 'http://server.test',
  token: INGEST_TOKEN,
  source: 'webhook-cli',
  symbol: 'XAUUSD',
  timeframe: '15',
  count: 3,
  price: 3985.25,
};

describe('webhook CLI against the real server', () => {
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

  describe('signal', () => {
    it.each(['BUY', 'SELL'] as const)('is accepted for a %s and reaches Discord with its levels', async (direction) => {
      const t = await h.build();
      const [result] = await sendSignal({ ...signalOptions, direction }, fetchThrough(t.app));

      expect(result).toMatchObject({ status: 200, ok: true, body: { status: 'accepted' } });
      await t.processor.idle();
      expect(h.notifier.sent).toHaveLength(1);
      expect(h.notifier.sent[0]).toContain(`${direction} CANDIDATE`);
      expect(h.notifier.sent[0]).toContain('Levels (indicative)');
    });

    it('answers duplicate when the same signal is sent twice', async () => {
      const t = await h.build();
      const results = await sendSignal({ ...signalOptions, twice: true }, fetchThrough(t.app));

      expect(results.map((result) => (result.body as { status: string }).status)).toEqual(['accepted', 'duplicate']);
      await t.processor.idle();
      expect(h.notifier.sent).toHaveLength(1);
    });

    it('is refused with a wrong token', async () => {
      const t = await h.build();
      const [result] = await sendSignal({ ...signalOptions, token: 'x'.repeat(24) }, fetchThrough(t.app));
      expect(result).toMatchObject({ status: 401, ok: false });
    });

    it('is refused when the candle is too old', async () => {
      const t = await h.build();
      const [result] = await sendSignal({ ...signalOptions, ageMinutes: 120 }, fetchThrough(t.app));
      expect(result).toMatchObject({ status: 400, ok: false });
      expect(JSON.stringify(result?.body)).toContain('stale_signal');
    });

    it('is refused for a timeframe the server does not accept', async () => {
      const t = await h.build();
      const [result] = await sendSignal({ ...signalOptions, timeframe: '30' }, fetchThrough(t.app));
      expect(JSON.stringify(result?.body)).toContain('unsupported_timeframe');
    });
  });

  describe('bars', () => {
    it('stores the candles, and answers duplicates the second time', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const fetchImpl = fetchThrough(t.app);

      expect(await sendBars(barsOptions, fetchImpl)).toMatchObject({
        status: 200,
        body: { status: 'ok', received: 3, inserted: 3, duplicates: 0 },
      });
      expect(await sendBars(barsOptions, fetchImpl)).toMatchObject({
        status: 200,
        body: { inserted: 0, duplicates: 3 },
      });
    });

    it.each(['5', '15', '60'])('accepts %s-minute candles', async (timeframe) => {
      const t = await h.build({ INGEST_TOKEN });
      const result = await sendBars({ ...barsOptions, timeframe, count: 2 }, fetchThrough(t.app));
      expect(result).toMatchObject({ status: 200, body: { inserted: 2 } });
    });

    it('is refused with a wrong token, and does not exist without INGEST_TOKEN', async () => {
      const t = await h.build({ INGEST_TOKEN });
      expect(await sendBars({ ...barsOptions, token: 'y'.repeat(24) }, fetchThrough(t.app))).toMatchObject({
        status: 401,
      });

      const without = await h.build();
      expect(await sendBars(barsOptions, fetchThrough(without.app))).toMatchObject({ status: 404 });
    });
  });

  it('reads the health of the server', async () => {
    const t = await h.build();
    expect(await checkHealth('http://server.test', fetchThrough(t.app))).toMatchObject({
      status: 200,
      body: { status: 'ok' },
    });
  });
});
