import moment from 'moment-timezone';

export type Direction = 'BUY' | 'SELL';

const round = (value: number) => Math.round(value * 100) / 100;
const isoSeconds = (value: moment.Moment) => value.format('YYYY-MM-DDTHH:mm:ss[Z]');

export interface SignalOptions {
  token: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  price: number;
  /** How long ago the candle opened. The server rejects signals older than MAX_SIGNAL_AGE_MINUTES. */
  ageMinutes: number;
  /** Include the indicative stop and target (`plan`). */
  plan: boolean;
}

/**
 * A body shaped like the alert the indicator sends (payload v1.1), with plausible numbers. It is
 * written out here on purpose: the CLI is a client of the webhook, so it does not share code with
 * the server and would notice if the contract drifted.
 */
export function buildSignalPayload(
  options: SignalOptions,
  now: moment.MomentInput = moment(),
): Record<string, unknown> {
  const { direction, price } = options;
  const sign = direction === 'BUY' ? 1 : -1;
  const candleTime = moment.utc(now).subtract(options.ageMinutes, 'minutes').startOf('minute');

  return {
    version: '1.1',
    token: options.token,
    symbol: options.symbol,
    timeframe: options.timeframe,
    timestamp: isoSeconds(candleTime),
    direction,
    price,
    indicators: {
      ema_fast: round(price - sign * 1.8),
      ema_slow: round(price - sign * 5.1),
      rsi: direction === 'BUY' ? 56.2 : 41.3,
      macd: sign * 1.15,
      macd_signal: sign * 0.82,
      macd_histogram: sign * 0.33,
      atr: 2.4,
    },
    levels: { swing_low: round(price - 6.75), swing_high: round(price + 4.75) },
    htf: { trend: sign },
    ...(options.plan && { plan: { stop: round(price - sign * 40), target: round(price + sign * 60) } }),
  };
}

export interface BarsOptions {
  source: string;
  symbol: string;
  /** Candle length in minutes; has to divide 60 so candles open on UTC multiples of it. */
  timeframe: string;
  count: number;
  price: number;
}

/** The last `count` fully closed candles, oldest first, the way the MT5 Expert Advisor sends them. */
export function buildBarsPayload(
  options: BarsOptions,
  now: moment.MomentInput = moment(),
): Record<string, unknown> {
  const minutes = Number(options.timeframe);
  const current = moment.utc(now);
  const forming = current
    .clone()
    .startOf('hour')
    .add(Math.floor(current.minutes() / minutes) * minutes, 'minutes');

  const bars = Array.from({ length: options.count }, (_, index) => {
    const barsAgo = options.count - index;
    const open = round(options.price + ((index % 3) - 1) * 0.4);
    const close = round(options.price + ((index % 4) - 1.5) * 0.3);
    return {
      time: isoSeconds(forming.clone().subtract(barsAgo * minutes, 'minutes')),
      open,
      high: round(Math.max(open, close) + 1.2),
      low: round(Math.min(open, close) - 1.1),
      close,
      tick_volume: 800 + index,
      spread_min: 0.2,
      spread_avg: 0.31,
      spread_max: 0.9,
    };
  });

  return { source: options.source, symbol: options.symbol, timeframe: options.timeframe, bars };
}
