import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const csv = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? fallback)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

const timezone = z
  .string()
  .default('Asia/Jakarta')
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid IANA time zone');

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z
    .string()
    .refine((url) => /^postgres(ql)?:\/\//.test(url), 'must be a postgres:// or postgresql:// URL'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  WEBHOOK_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  ALLOWED_IPS: csv(''),
  ALLOWED_SYMBOLS: csv('XAUUSD').transform((items) => items.map((item) => item.toUpperCase())),
  ALLOWED_TIMEFRAMES: csv('15'),
  // Bar ingestion (forward test data from the MT5 Expert Advisor). Disabled when no token is set.
  INGEST_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(16, 'must be at least 16 characters').optional(),
  ),
  BAR_TIMEFRAMES: csv('5,15,60'),
  MAX_SIGNAL_AGE_MINUTES: z.coerce.number().positive().default(60),
  DISPLAY_TIMEZONE: timezone,
  DISCORD_WEBHOOK_URL: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .refine((url) => url.startsWith('https://'), 'must be an https:// URL')
      .optional(),
  ),
  DISCORD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  DISCORD_BACKOFF_MS: z.coerce.number().int().min(0).default(1000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
