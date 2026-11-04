import { describe, expect, it } from 'vitest';
import { formatSignalMessage } from '../../src/alerts/format.js';
import { buildIdempotencyKey } from '../../src/alerts/idempotency.js';
import type { SignalRecord } from '../../src/alerts/store.js';

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
