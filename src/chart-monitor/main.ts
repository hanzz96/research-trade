import { setTimeout as sleep } from 'node:timers/promises';
import moment from 'moment-timezone';
import { pino, type Logger } from 'pino';
import { migrate } from '../migrations.js';
import { PgDb, type Db } from '../shared/db.js';
import { DiscordNotifier } from '../shared/discord.js';
import { toIsoString } from '../shared/time.js';
import { evaluateInChart } from './cdp.js';
import { readChart } from './chart-reader.js';
import { loadMonitorConfig, type MonitorConfig } from './config.js';
import { FilePendingLog } from './fallback.js';
import { checkOnce, type CheckResult, type MonitorDeps } from './monitor.js';
import { nextRunAt } from './schedule.js';
import { PgMonitorStore } from './store.js';

function buildDeps(config: MonitorConfig, db: Db, log: Logger): MonitorDeps {
  return {
    config,
    log,
    notifier: new DiscordNotifier(config.DISCORD_WEBHOOK_URL),
    store: new PgMonitorStore(db, config.MONITOR_SYMBOL, config.MONITOR_TIMEFRAME),
    fallback: new FilePendingLog(config.MONITOR_FALLBACK_FILE),
    readChart: () =>
      readChart(
        (expression) => evaluateInChart({ host: config.CDP_HOST, port: config.CDP_PORT }, expression),
        config.MONITOR_STUDY,
      ),
  };
}

/** Aborted when the process is asked to stop (Ctrl+C or SIGTERM). */
function stopSignal(): AbortSignal {
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  return stop.signal;
}

/** One check that cannot bring the loop down: an unexpected error becomes a failed result. */
async function runCheck(deps: MonitorDeps): Promise<CheckResult> {
  try {
    return await checkOnce(deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    deps.log.error({ err: reason }, 'check crashed');
    return { status: 'failed', reason };
  }
}

/** Waits until shortly after the next candle closes. False if the process was told to stop meanwhile. */
async function waitForNextCandle(config: MonitorConfig, log: Logger, stop: AbortSignal): Promise<boolean> {
  const next = nextRunAt(moment(), Number(config.MONITOR_TIMEFRAME), config.MONITOR_DELAY_SECONDS);
  log.info({ next: toIsoString(next) }, 'waiting for the next candle');
  try {
    await sleep(next.getTime() - Date.now(), undefined, { signal: stop });
    return true;
  } catch {
    return false;
  }
}

/**
 * Entry point of the chart monitor, a separate process from the webhook server.
 *   npm run monitor        checks after every candle close until stopped
 *   npm run monitor:once   one check, then exit (for cron or launchd); exit code 1 on failure
 */
async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = loadMonitorConfig();
  const log = pino({ redact: ['webhookUrl', 'DISCORD_WEBHOOK_URL', 'DATABASE_URL'] });

  const db = new PgDb(config.DATABASE_URL);
  try {
    await migrate(db);
    const deps = buildDeps(config, db, log);
    const stop = stopSignal();

    while (!stop.aborted) {
      console.log("Running..")
      const result = await runCheck(deps);
      log.info(result, 'check finished');

      if (once) {
        process.exitCode = result.status === 'failed' ? 1 : 0;
        return;
      }
      if (!(await waitForNextCandle(config, log, stop))) break;
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
