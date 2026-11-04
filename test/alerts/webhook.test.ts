import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, permanent, retryable, TOKEN, validPayload } from '../support/helpers.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;

describe('POST /webhook/tradingview', () => {
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

  const rejections = async () =>
    (await h.db.query<{ reason: string; detail: string | null }>(
      'SELECT reason, detail FROM webhook_rejections ORDER BY id',
    )).rows;
  const signalCount = async () =>
    (await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM signals')).rows[0]!.n;
  const deliveries = async () =>
    (await h.db.query<{ status: string; attempt_count: number; error_message: string | null }>(
      'SELECT status, attempt_count, error_message FROM alert_deliveries ORDER BY id',
    )).rows;

  describe('accepted signals', () => {
    it('stores a valid BUY signal and sends exactly one Discord message', async () => {
      const t = await h.build();
      const res = await t.post(validPayload());

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'accepted' });

      await t.processor.idle();
      const signal = await h.store.get(res.json().id);
      expect(signal?.status).toBe('SENT');
      expect(h.notifier.sent).toHaveLength(1);
      expect(h.notifier.sent[0]).toContain('XAU/USD — BUY CANDIDATE');
      expect(h.notifier.sent[0]).toContain('3985.25');
      expect(await deliveries()).toEqual([
        { status: 'SENT', attempt_count: 1, error_message: null },
      ]);
    });

    it('accepts the text/plain content type TradingView uses for non-JSON-looking messages', async () => {
      const t = await h.build();
      const res = await t.post(validPayload(), { headers: { 'content-type': 'text/plain' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('accepted');
    });

    it('stores the indicative stop/target and shows them in the Discord message', async () => {
      const t = await h.build();
      const res = await t.post(validPayload({ plan: { stop: 3975.4, target: 4001.5 } }));
      expect(res.statusCode).toBe(200);

      await t.processor.idle();
      const signal = await h.store.get(res.json().id);
      expect(signal?.snapshot.plan).toEqual({ stop: 3975.4, target: 4001.5 });
      expect(h.notifier.sent[0]).toContain('Entry 3985.25 | stop 3975.40 | target 4001.50');
    });

    it('rejects a plan whose stop or target sits on the wrong side of the price', async () => {
      const t = await h.build();
      const res = await t.post(validPayload({ direction: 'BUY', plan: { stop: 3990, target: 4001.5 } }));
      expect(res.statusCode).toBe(400);
      expect(await signalCount()).toBe(0);
    });

    it('never persists the shared token', async () => {
      const t = await h.build();
      const res = await t.post(validPayload());
      await t.processor.idle();

      const signal = await h.store.get(res.json().id);
      expect(JSON.stringify(signal)).not.toContain(TOKEN);
      const raw = await h.db.query('SELECT * FROM signals');
      expect(JSON.stringify(raw.rows)).not.toContain(TOKEN);
    });

    it('treats the same candle with a different direction as a separate signal', async () => {
      const t = await h.build();
      const timestamp = new Date(Date.now() - 5 * 60_000).toISOString();
      await t.post(validPayload({ timestamp, direction: 'BUY' }));
      await t.post(validPayload({ timestamp, direction: 'SELL' }));
      await t.processor.idle();
      expect(await signalCount()).toBe(2);
      expect(h.notifier.sent).toHaveLength(2);
    });
  });

  describe('deduplication', () => {
    it('does not store or notify twice for the same symbol, timeframe, candle and direction', async () => {
      const t = await h.build();
      const payload = validPayload();

      const first = await t.post(payload);
      const second = await t.post(payload);
      const third = await t.post({ ...payload, price: 9999 });
      await t.processor.idle();

      expect(first.json().status).toBe('accepted');
      expect(second.json()).toMatchObject({ status: 'duplicate', id: first.json().id });
      expect(third.json().status).toBe('duplicate');
      expect(await signalCount()).toBe(1);
      expect(h.notifier.sent).toHaveLength(1);
    });

    it('ignores any event id supplied by the client', async () => {
      const t = await h.build();
      const payload = validPayload();
      await t.post({ ...payload, event_id: 'a' });
      const res = await t.post({ ...payload, event_id: 'b' });
      expect(res.json().status).toBe('duplicate');
    });
  });

  describe('rejections', () => {
    it('returns 401 for a wrong token and stores nothing', async () => {
      const t = await h.build();
      const res = await t.post(validPayload({ token: 'wrong-token-wrong-token' }));
      expect(res.statusCode).toBe(401);
      expect(await signalCount()).toBe(0);
      expect(await rejections()).toEqual([{ reason: 'unauthorized', detail: null }]);
    });

    it('returns 401 when the token is missing', async () => {
      const t = await h.build();
      const payload = validPayload();
      delete payload.token;
      expect((await t.post(payload)).statusCode).toBe(401);
    });

    it('returns 400 for a body that is not JSON', async () => {
      const t = await h.build();
      const res = await t.post('this is not json');
      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('invalid_json');
    });

    it('returns 400 and names the missing field', async () => {
      const t = await h.build();
      const payload = validPayload();
      delete (payload.indicators as Record<string, unknown>).rsi;
      const res = await t.post(payload);

      expect(res.statusCode).toBe(400);
      const [rejection] = await rejections();
      expect(rejection?.reason).toBe('invalid_payload');
      expect(rejection?.detail).toContain('indicators.rsi');
      expect(await signalCount()).toBe(0);
    });

    it('rejects out-of-range indicator values', async () => {
      const t = await h.build();
      const payload = validPayload();
      (payload.indicators as Record<string, unknown>).rsi = 120;
      expect((await t.post(payload)).statusCode).toBe(400);
    });

    it('rejects an unsupported symbol', async () => {
      const t = await h.build();
      const res = await t.post(validPayload({ symbol: 'EURUSD' }));
      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('unsupported_symbol');
    });

    it('rejects an unsupported timeframe', async () => {
      const t = await h.build();
      const res = await t.post(validPayload({ timeframe: '5' }));
      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('unsupported_timeframe');
    });

    it('rejects stale signals', async () => {
      const t = await h.build();
      const timestamp = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const res = await t.post(validPayload({ timestamp }));
      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('stale_signal');
    });

    it('rejects timestamps in the future', async () => {
      const t = await h.build();
      const timestamp = new Date(Date.now() + 3_600_000).toISOString();
      const res = await t.post(validPayload({ timestamp }));
      expect(res.statusCode).toBe(400);
      expect((await rejections())[0]?.reason).toBe('timestamp_in_future');
    });

    it('rate limits a caller that floods the endpoint', async () => {
      const t = await h.build();
      let last = 0;
      for (let i = 0; i < 61; i += 1) {
        last = (await t.post('not json')).statusCode;
      }
      expect(last).toBe(429);
    });
  });

  describe('IP allowlist', () => {
    it('blocks callers that are not on the list', async () => {
      const t = await h.build({ ALLOWED_IPS: '10.0.0.1' });
      const res = await t.post(validPayload());
      expect(res.statusCode).toBe(403);
      expect((await rejections())[0]?.reason).toBe('ip_not_allowed');
    });

    it('allows a listed caller', async () => {
      const t = await h.build({ ALLOWED_IPS: '10.0.0.1' });
      const res = await t.post(validPayload(), { remoteAddress: '10.0.0.1' });
      expect(res.statusCode).toBe(200);
    });

    it('cannot be bypassed by forging X-Forwarded-For behind the tunnel', async () => {
      const t = await h.build({ ALLOWED_IPS: '10.0.0.1' });
      // The tunnel appends the real client (6.6.6.6) last; the forged leading entry must not win.
      const res = await t.post(validPayload(), {
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1, 6.6.6.6' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Discord delivery', () => {
    it('retries a transient failure and then succeeds', async () => {
      const t = await h.build();
      h.notifier.failNext(retryable());
      const res = await t.post(validPayload());
      await t.processor.idle();

      expect((await h.store.get(res.json().id))?.status).toBe('SENT');
      expect(await deliveries()).toEqual([
        { status: 'SENT', attempt_count: 2, error_message: null },
      ]);
      expect(h.notifier.sent).toHaveLength(1);
    });

    it('gives up on a permanent failure without retrying', async () => {
      const t = await h.build();
      h.notifier.failNext(permanent('bad webhook'));
      const res = await t.post(validPayload());
      await t.processor.idle();

      const signal = await h.store.get(res.json().id);
      expect(signal?.status).toBe('FAILED');
      expect(signal?.error).toBe('bad webhook');
      expect(await deliveries()).toEqual([
        { status: 'FAILED', attempt_count: 1, error_message: 'bad webhook' },
      ]);
    });

    it('marks the signal FAILED after exhausting the retry budget, keeping the stored signal', async () => {
      const t = await h.build();
      h.notifier.failNext(retryable('1'), retryable('2'), retryable('3'));
      const res = await t.post(validPayload());
      await t.processor.idle();

      expect((await h.store.get(res.json().id))?.status).toBe('FAILED');
      expect((await deliveries())[0]).toMatchObject({ status: 'FAILED', attempt_count: 3 });
      expect(h.notifier.sent).toHaveLength(0);
    });

    it('still answers 200 quickly while Discord is down', async () => {
      const t = await h.build();
      h.notifier.failNext(permanent());
      const res = await t.post(validPayload());
      expect(res.statusCode).toBe(200);
    });
  });

  describe('restart recovery', () => {
    it('re-sends signals left in PROCESSING or RECEIVED by a previous run', async () => {
      const t = await h.build();
      const base = {
        symbol: 'XAUUSD',
        timeframe: '15',
        direction: 'BUY' as const,
        snapshot: {
          price: 3985.25,
          indicators: {
            ema_fast: 1, ema_slow: 1, rsi: 50, macd: 0, macd_signal: 0, macd_histogram: 0, atr: 1,
          },
          levels: { swing_low: 1, swing_high: 2 },
          htf: { trend: 0 as const },
        },
      };
      const stuck = await h.store.insert({
        ...base,
        idempotencyKey: 'k1',
        candleTimestamp: new Date(Date.now() - 600_000).toISOString(),
      });
      const queued = await h.store.insert({
        ...base,
        idempotencyKey: 'k2',
        candleTimestamp: new Date(Date.now() - 300_000).toISOString(),
      });
      await h.store.claim(stuck.id); // simulates a crash mid-delivery

      expect(await t.processor.recover()).toBe(2);
      await t.processor.idle();

      expect((await h.store.get(stuck.id))?.status).toBe('SENT');
      expect((await h.store.get(queued.id))?.status).toBe('SENT');
      expect(h.notifier.sent).toHaveLength(2);
    });
  });

  describe('GET /health', () => {
    it('reports counts per status', async () => {
      const t = await h.build();
      await t.post(validPayload());
      await t.processor.idle();
      const res = await t.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok', signals: { SENT: 1 }, bars: {} });
    });
  });
});
