import { describe, expect, it } from 'vitest';
import { buildBarsPayload, buildSignalPayload, type SignalOptions } from '../../src/webhook-cli/payloads.js';

const NOW = '2026-11-04T09:12:34Z';
const signal = (overrides: Partial<SignalOptions> = {}): SignalOptions => ({
  token: 'secret-token',
  symbol: 'XAUUSD',
  timeframe: '15',
  direction: 'BUY',
  price: 3985.25,
  ageMinutes: 5,
  plan: true,
  ...overrides,
});

describe('buildSignalPayload', () => {
  it('has the shape of the indicator alert', () => {
    expect(buildSignalPayload(signal(), NOW)).toEqual({
      version: '1.1',
      token: 'secret-token',
      symbol: 'XAUUSD',
      timeframe: '15',
      timestamp: '2026-11-04T09:07:00Z',
      direction: 'BUY',
      price: 3985.25,
      indicators: {
        ema_fast: 3983.45,
        ema_slow: 3980.15,
        rsi: 56.2,
        macd: 1.15,
        macd_signal: 0.82,
        macd_histogram: 0.33,
        atr: 2.4,
      },
      levels: { swing_low: 3978.5, swing_high: 3990 },
      htf: { trend: 1 },
      plan: { stop: 3945.25, target: 4045.25 },
    });
  });

  it('dates the candle to the minute, the given age ago', () => {
    expect(buildSignalPayload(signal({ ageMinutes: 0 }), NOW).timestamp).toBe('2026-11-04T09:12:00Z');
    expect(buildSignalPayload(signal({ ageMinutes: 90 }), NOW).timestamp).toBe('2026-11-04T07:42:00Z');
  });

  it('mirrors the numbers for a SELL, with the stop above and the target below the price', () => {
    const payload = buildSignalPayload(signal({ direction: 'SELL' }), NOW) as Record<string, any>;
    expect(payload.htf).toEqual({ trend: -1 });
    expect(payload.indicators.rsi).toBe(41.3);
    expect(payload.indicators.macd).toBe(-1.15);
    expect(payload.plan).toEqual({ stop: 4025.25, target: 3925.25 });
  });

  it('leaves out the plan on request', () => {
    expect(buildSignalPayload(signal({ plan: false }), NOW)).not.toHaveProperty('plan');
  });
});

describe('buildBarsPayload', () => {
  const bars = (overrides = {}) =>
    buildBarsPayload(
      { source: 'webhook-cli', symbol: 'XAUUSD', timeframe: '15', count: 3, price: 3985.25, ...overrides },
      NOW,
    ) as {
      source: string;
      symbol: string;
      timeframe: string;
      bars: Array<Record<string, number | string>>;
    };

  it('sends the closed candles before the one still forming, oldest first', () => {
    // 09:12 is inside the 09:00 candle, so the last closed one opened at 08:45.
    expect(bars().bars.map((bar) => bar.time)).toEqual([
      '2026-11-04T08:15:00Z',
      '2026-11-04T08:30:00Z',
      '2026-11-04T08:45:00Z',
    ]);
  });

  it('follows the timeframe', () => {
    expect(bars({ timeframe: '60', count: 2 }).bars.map((bar) => bar.time)).toEqual([
      '2026-11-04T07:00:00Z',
      '2026-11-04T08:00:00Z',
    ]);
    expect(bars({ timeframe: '5', count: 1 }).bars[0]?.time).toBe('2026-11-04T09:05:00Z');
  });

  it('draws consistent candles with a spread', () => {
    for (const bar of bars({ count: 8 }).bars) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(Number(bar.open), Number(bar.close)));
      expect(bar.low).toBeLessThanOrEqual(Math.min(Number(bar.open), Number(bar.close)));
      expect(bar.spread_avg).toBeGreaterThan(0);
    }
  });

  it('names the source, symbol and timeframe', () => {
    expect(bars()).toMatchObject({ source: 'webhook-cli', symbol: 'XAUUSD', timeframe: '15' });
  });
});
