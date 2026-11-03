import { pino } from 'pino';
import { loadConfig } from './config.js';
import { PgDb } from './db.js';
import { DiscordNotifier, DisabledNotifier } from './discord.js';
import { migrate } from './migrations.js';
import { SignalProcessor } from './processor.js';
import { buildServer } from './server.js';
import { SignalStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.LOG_LEVEL,
    // Defence in depth: the token and webhook URL must never reach the logs.
    redact: ['token', 'req.body.token', 'webhookUrl', 'DISCORD_WEBHOOK_URL', 'WEBHOOK_TOKEN'],
  });

  const db = new PgDb(config.DATABASE_URL);
  await migrate(db);
  const store = new SignalStore(db);

  const notifier = config.DISCORD_WEBHOOK_URL
    ? new DiscordNotifier(config.DISCORD_WEBHOOK_URL)
    : new DisabledNotifier();
  if (!config.DISCORD_WEBHOOK_URL) {
    log.warn('DISCORD_WEBHOOK_URL is not set: signals will be stored but not delivered');
  }

  const processor = new SignalProcessor({
    store,
    notifier,
    log,
    displayTimezone: config.DISPLAY_TIMEZONE,
    maxAttempts: config.DISCORD_MAX_ATTEMPTS,
    backoffMs: config.DISCORD_BACKOFF_MS,
  });
  const server = await buildServer({ config, store, processor, logger: log });

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
