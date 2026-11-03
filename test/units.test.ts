import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DiscordNotifier, NotifyError } from '../src/discord.js';
import { displaySymbol, displayTimeframe, formatSignalMessage } from '../src/format.js';
import { buildIdempotencyKey } from '../src/idempotency.js';
import type { SignalRecord } from '../src/store.js';

const baseEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
  WEBHOOK_TOKEN: 'a-long-enough-token-1234',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 3000,
      ALLOWED_SYMBOLS: ['XAUUSD'],
      ALLOWED_TIMEFRAMES: ['15'],
      ALLOWED_IPS: [],
      DISPLAY_TIMEZONE: 'Asia/Jakarta',
    });
    expect(config.DISCORD_WEBHOOK_URL).toBeUndefined();
  });

  it('fails fast and names every problem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*WEBHOOK_TOKEN/);
  });

  it('rejects a short token and a non-postgres URL', () => {
    expect(() => loadConfig({ ...baseEnv, WEBHOOK_TOKEN: 'short' })).toThrow(/WEBHOOK_TOKEN/);
    expect(() => loadConfig({ ...baseEnv, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('parses comma lists and upper-cases symbols', () => {
    const config = loadConfig({
      ...baseEnv,
      ALLOWED_SYMBOLS: 'xauusd, eurusd',
      ALLOWED_IPS: '1.1.1.1,2.2.2.2',
    });
    expect(config.ALLOWED_SYMBOLS).toEqual(['XAUUSD', 'EURUSD']);
    expect(config.ALLOWED_IPS).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('treats an empty DISCORD_WEBHOOK_URL as unset and requires https otherwise', () => {
    expect(loadConfig({ ...baseEnv, DISCORD_WEBHOOK_URL: '' }).DISCORD_WEBHOOK_URL).toBeUndefined();
    expect(() => loadConfig({ ...baseEnv, DISCORD_WEBHOOK_URL: 'http://discord.com/x' })).toThrow(
      /DISCORD_WEBHOOK_URL/,
    );
  });

  it('rejects an unknown time zone', () => {
    expect(() => loadConfig({ ...baseEnv, DISPLAY_TIMEZONE: 'Mars/Base' })).toThrow(
      /DISPLAY_TIMEZONE/,
    );
  });
});

describe('buildIdempotencyKey', () => {
  it('is stable across symbol case and millisecond formatting', () => {
    const a = buildIdempotencyKey({
      symbol: 'xauusd', timeframe: '15', timestamp: '2026-11-02T10:15:00Z', direction: 'BUY',
    });
    const b = buildIdempotencyKey({
      symbol: 'XAUUSD', timeframe: '15', timestamp: '2026-11-02T10:15:00.000Z', direction: 'BUY',
    });
    expect(a).toBe(b);
  });

  it('differs by direction, timeframe and candle', () => {
    const base = {
      symbol: 'XAUUSD', timeframe: '15', timestamp: '2026-11-02T10:15:00Z', direction: 'BUY',
    };
    const key = buildIdempotencyKey(base);
    expect(buildIdempotencyKey({ ...base, direction: 'SELL' })).not.toBe(key);
    expect(buildIdempotencyKey({ ...base, timeframe: '60' })).not.toBe(key);
    expect(buildIdempotencyKey({ ...base, timestamp: '2026-11-02T10:30:00Z' })).not.toBe(key);
  });
});

describe('formatting', () => {
  it.each([
    ['15', 'M15'],
    ['60', 'H1'],
    ['240', 'H4'],
    ['1D', 'D1'],
    ['D', 'D1'],
    ['1W', 'W1'],
    ['1M', 'MN1'],
  ])('displays timeframe %s as %s', (input, expected) => {
    expect(displayTimeframe(input)).toBe(expected);
  });

  it('displays currency pairs with a slash and leaves other symbols alone', () => {
    expect(displaySymbol('XAUUSD')).toBe('XAU/USD');
    expect(displaySymbol('BTCUSDT')).toBe('BTCUSDT');
  });

  it('renders the alert with local time, indicators and the alert-only warning', () => {
    const signal: SignalRecord = {
      id: 1,
      idempotencyKey: 'k',
      symbol: 'XAUUSD',
      timeframe: '15',
      direction: 'SELL',
      candleTimestamp: '2026-11-02T10:15:00.000Z',
      receivedAt: '2026-11-02T10:30:01.000Z',
      status: 'RECEIVED',
      error: null,
      snapshot: {
        price: 3980.5,
        indicators: {
          ema_fast: 3979.1, ema_slow: 3981.2, rsi: 41.26, macd: -0.45, macd_signal: -0.3,
          macd_histogram: -0.15, atr: 2.1,
        },
        levels: { swing_low: 3975, swing_high: 3988 },
        htf: { trend: -1 },
      },
    };
    const message = formatSignalMessage(signal, 'Asia/Jakarta');
    expect(message).toContain('XAU/USD — SELL CANDIDATE** (M15)');
    expect(message).toContain('2026-11-02 17:15 (Asia/Jakarta)');
    expect(message).toContain('RSI: 41.3');
    expect(message).toContain('BEARISH');
    expect(message).toContain('NEEDS_INPUT');
    expect(message).toContain('Alert-only');
  });
});

describe('DiscordNotifier', () => {
  const url = 'https://discord.com/api/webhooks/123/secret-token';
  const notifier = (fetchImpl: typeof fetch) => new DiscordNotifier(url, fetchImpl);

  it('posts the content with mentions disabled', async () => {
    let captured: RequestInit | undefined;
    await notifier(async (_input, init) => {
      captured = init;
      return new Response(null, { status: 204 });
    }).send('hello @everyone');

    expect(JSON.parse(String(captured?.body))).toEqual({
      content: 'hello @everyone',
      allowed_mentions: { parse: [] },
    });
  });

  it('treats 429 as retryable and honours retry_after', async () => {
    const error = await notifier(
      async () => new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
    )
      .send('x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotifyError);
    expect(error).toMatchObject({ retryable: true, retryAfterMs: 1500 });
  });

  it('retries 5xx but not other 4xx', async () => {
    const serverError = await notifier(async () => new Response(null, { status: 503 }))
      .send('x')
      .catch((e: unknown) => e);
    const clientError = await notifier(async () => new Response(null, { status: 404 }))
      .send('x')
      .catch((e: unknown) => e);
    expect(serverError).toMatchObject({ retryable: true });
    expect(clientError).toMatchObject({ retryable: false });
  });

  it('never leaks the webhook URL in error messages', async () => {
    const error = (await notifier(async () => {
      throw new TypeError(`fetch failed for ${url}`);
    })
      .send('x')
      .catch((e: unknown) => e)) as NotifyError;
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('secret-token');
    expect(error.message).not.toContain(url);
  });
});
