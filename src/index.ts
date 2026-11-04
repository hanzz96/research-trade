import { pino } from 'pino';
import { DisabledNotifier, DiscordNotifier } from './shared/discord.js';
import { SignalProcessor } from './alerts/processor.js';
import { SignalStore } from './alerts/store.js';
import { BarStore } from './forward-test/bars.js';
import { migrate } from './migrations.js';
import { buildServer } from './server.js';
import { loadConfig } from './shared/config.js';
import { PgDb } from './shared/db.js';
import { RejectionLog } from './shared/rejections.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.LOG_LEVEL,
    // Defence in depth: tokens and webhook URLs must never reach the logs.
    redact: [
      'token',
      'req.body.token',
      'webhookUrl',
      'DISCORD_WEBHOOK_URL',
      'WEBHOOK_TOKEN',
      'INGEST_TOKEN',
    ],
  });

  const db = new PgDb(config.DATABASE_URL);
  await migrate(db);
  const store = new SignalStore(db);
  const barStore = new BarStore(db);
  const rejections = new RejectionLog(db);

  const notifier = config.DISCORD_WEBHOOK_URL
    ? new DiscordNotifier(config.DISCORD_WEBHOOK_URL)
    : new DisabledNotifier();
  if (!config.DISCORD_WEBHOOK_URL) {
    log.warn('DISCORD_WEBHOOK_URL is not set: signals will be stored but not delivered');
  }
  if (!config.INGEST_TOKEN) {
    log.warn('INGEST_TOKEN is not set: bar ingestion (/ingest/bars) is disabled');
  }

  const processor = new SignalProcessor({
    store,
    notifier,
    log,
    displayTimezone: config.DISPLAY_TIMEZONE,
    maxAttempts: config.DISCORD_MAX_ATTEMPTS,
    backoffMs: config.DISCORD_BACKOFF_MS,
  });
  const server = await buildServer({ config, store, processor, rejections, barStore, logger: log });

  const recovered = await processor.recover();
  if (recovered > 0) log.info({ recovered }, 'requeued unfinished signals');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    await server.close();
    await processor.idle();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
