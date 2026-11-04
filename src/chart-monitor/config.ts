import { z } from 'zod';
import { timezone } from '../shared/config.js';

const envSchema = z.object({
  DISCORD_WEBHOOK_URL: z
    .url()
    .refine((url) => url.startsWith('https://'), 'must be an https:// URL'),
  // TradingView Desktop must be started with --remote-debugging-port=<CDP_PORT>.
  CDP_HOST: z.string().default('127.0.0.1'),
  CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9222),
  MONITOR_SYMBOL: z
    .string()
    .default('XAUUSD')
    .transform((value) => value.toUpperCase()),
  // Candle length in minutes. It has to divide the hour so candles close on predictable minutes.
  MONITOR_TIMEFRAME: z
    .string()
    .regex(/^\d+$/, 'must be a number of minutes')
    .refine((value) => 60 % Number(value) === 0, 'must divide 60 (for example 15, 30 or 60)')
    .default('30'),
  MONITOR_STUDY: z.string().min(1).default('XAUUSD Entry Reminder'),
  MONITOR_STATE_FILE: z.string().min(1).default('.monitor-state.json'),
  // Seconds to wait after a candle closes before reading the chart.
  MONITOR_DELAY_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  DISPLAY_TIMEZONE: timezone,
});

export type MonitorConfig = z.infer<typeof envSchema>;

export function loadMonitorConfig(
  env: Record<string, string | undefined> = process.env,
): MonitorConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid chart monitor configuration:\n  ${issues}`);
  }
  return parsed.data;
}
