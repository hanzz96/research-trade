import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { NotifyError, type Notifier } from '../src/discord.js';
import { migrate } from '../src/migrations.js';
import { SignalProcessor } from '../src/processor.js';
import { buildServer } from '../src/server.js';
import { SignalStore } from '../src/store.js';
import { PgliteDb } from './pglite-db.js';

export const TOKEN = 'test-token-0123456789abcdef';

export class FakeNotifier implements Notifier {
  sent: string[] = [];
  private failures: Error[] = [];

  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  reset(): void {
    this.sent = [];
    this.failures = [];
  }

  async send(content: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(content);
  }
}

export const retryable = (message = 'temporary failure') => new NotifyError(message, true);
export const permanent = (message = 'bad webhook') => new NotifyError(message, false);

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    WEBHOOK_TOKEN: TOKEN,
    DISCORD_BACKOFF_MS: '0',
    ...overrides,
  });
}

export function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.1',
    token: TOKEN,
    symbol: 'XAUUSD',
    timeframe: '15',
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    direction: 'BUY',
    price: 3985.25,
    indicators: {
      ema_fast: 3983.4,
      ema_slow: 3980.1,
      rsi: 56.2,
      macd: 1.15,
      macd_signal: 0.82,
      macd_histogram: 0.33,
      atr: 2.4,
    },
    levels: { swing_low: 3978.5, swing_high: 3990.0 },
    htf: { trend: 1 },
    ...overrides,
  };
}

const silentLog = { info() {}, warn() {}, error() {} };

export interface TestApp {
  app: FastifyInstance;
  processor: SignalProcessor;
  config: Config;
  post(body: unknown, options?: Partial<InjectOptions>): Promise<LightMyRequestResponse>;
}

/** One PGlite database shared by a test file; `reset()` empties it between tests. */
export async function createHarness() {
  const db = await PgliteDb.create();
  await migrate(db);
  const store = new SignalStore(db);
  const notifier = new FakeNotifier();
  const apps: FastifyInstance[] = [];

  const build = async (overrides: Record<string, string> = {}): Promise<TestApp> => {
    const config = testConfig(overrides);
    const processor = new SignalProcessor({
      store,
      notifier,
      log: silentLog,
      displayTimezone: config.DISPLAY_TIMEZONE,
      maxAttempts: config.DISCORD_MAX_ATTEMPTS,
      backoffMs: 0,
      sleep: async () => {},
    });
    const app = await buildServer({ config, store, processor });
    apps.push(app);
    return {
      app,
      processor,
      config,
      post: (body, options = {}) =>
        app.inject({
          method: 'POST',
          url: '/webhook/tradingview',
          headers: { 'content-type': 'application/json' },
          payload: typeof body === 'string' ? body : JSON.stringify(body),
          ...options,
        }),
    };
  };

  return {
    db,
    store,
    notifier,
    build,
    async reset() {
      await db.exec(
        'TRUNCATE alert_deliveries, webhook_rejections, signals RESTART IDENTITY CASCADE',
      );
      notifier.reset();
    },
    async close() {
      await Promise.all(apps.map((app) => app.close()));
      await db.close();
    },
  };
}
