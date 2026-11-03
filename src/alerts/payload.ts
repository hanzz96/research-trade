import { z } from 'zod';

export const DIRECTIONS = ['BUY', 'SELL'] as const;

/**
 * Webhook payload v1.1 sent by the TradingView alert message.
 * The shared `token` is checked before this schema runs and is never stored,
 * so it is intentionally absent here (unknown keys are stripped).
 */
export const signalPayloadSchema = z.object({
  version: z.literal('1.1'),
  symbol: z.string().trim().min(1).max(32),
  timeframe: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z]{1,4}$/, 'unexpected timeframe format'),
  // Candle open time in UTC, e.g. 2026-11-02T10:15:00Z.
  timestamp: z.iso.datetime(),
  direction: z.enum(DIRECTIONS),
  price: z.number().positive(),
  indicators: z.object({
    ema_fast: z.number().positive(),
    ema_slow: z.number().positive(),
    rsi: z.number().min(0).max(100),
    macd: z.number(),
    macd_signal: z.number(),
    macd_histogram: z.number(),
    atr: z.number().positive(),
  }),
  levels: z
    .object({
      swing_low: z.number().positive(),
      swing_high: z.number().positive(),
    })
    .refine((levels) => levels.swing_low <= levels.swing_high, 'swing_low must be <= swing_high'),
  htf: z.object({
    // 1 = bullish, -1 = bearish, 0 = neutral or filter disabled.
    trend: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  }),
  // Indicative stop and target computed by the indicator (swing +/- ATR buffer, R multiple).
  // Optional so alerts created before this field existed still validate.
  plan: z
    .object({
      stop: z.number().positive(),
      target: z.number().positive(),
    })
    .optional(),
}).superRefine((payload, ctx) => {
  if (!payload.plan) return;
  const { stop, target } = payload.plan;
  const sane =
    payload.direction === 'BUY'
      ? stop < payload.price && payload.price < target
      : target < payload.price && payload.price < stop;
  if (!sane) {
    ctx.addIssue({
      code: 'custom',
      path: ['plan'],
      message: 'stop and target must sit on opposite sides of the price for the direction',
    });
  }
});

export type SignalPayload = z.infer<typeof signalPayloadSchema>;
export type Direction = SignalPayload['direction'];
export type SignalSnapshot = Pick<SignalPayload, 'price' | 'indicators' | 'levels' | 'htf' | 'plan'>;
