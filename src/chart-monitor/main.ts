import { setTimeout as sleep } from 'node:timers/promises';
import { Cron } from 'croner';
import moment from 'moment-timezone';
import { pino, type Logger } from 'pino';
import { migrate } from '../migrations.js';
import { PgDb, type Db } from '../shared/db.js';
import { DiscordNotifier } from '../shared/discord.js';
import { evaluateInChart } from './cdp.js';
import { readChart } from './chart-reader.js';
import { loadMonitorConfig, type MonitorConfig } from './config.js';
import { FilePendingLog } from './fallback.js';
import { GOLD_WEEK, isTradingCandle, nextOpening } from './market.js';
import { checkOnce, type CheckResult, type MonitorDeps } from './monitor.js';
import { closedCandleOpen, cronPattern } from './schedule.js';
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

/** One check that cannot bring the monitor down: an unexpected error becomes a failed result. */
async function runCheck(deps: MonitorDeps): Promise<CheckResult> {
  try {
    return await checkOnce(deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    deps.log.error({ err: reason }, 'check crashed');
    return { status: 'failed', reason };
  }
}

async function checkAndLog(deps: MonitorDeps): Promise<CheckResult> {
  console.log("Running..")
  const result = await runCheck(deps);
  deps.log.info(result, 'check finished');
  return result;
}

const formatLocal = (value: moment.MomentInput, timeZone: string) =>
  moment.tz(value, timeZone).format('YYYY-MM-DD HH:mm:ss z');

/**
 * Checks the chart shortly after every candle close, but only while the market trades. The first
 * check has already run at startup, so this only schedules the following ones. Returns when the
 * process is asked to stop, after a check that is still running has finished.
 */
async function runSchedule(config: MonitorConfig, deps: MonitorDeps, stop: AbortSignal): Promise<void> {
  const { log } = deps;
  const period = Number(config.MONITOR_TIMEFRAME);
  const delay = config.MONITOR_DELAY_SECONDS;
  const week = config.MONITOR_MARKET_HOURS === 'gold' ? GOLD_WEEK : 'always';
  const timeZone = config.DISPLAY_TIMEZONE;

  /** Whether the candle that closed most recently belongs to the trading week. */
  const marketOpen = () => isTradingCandle(closedCandleOpen(moment(), period, delay), week);
  const logMarket = (open: boolean) =>
    open || week === 'always'
      ? log.info({ market: 'open' }, 'market open, checks run')
      : log.info(
          { market: 'closed', reopens: formatLocal(nextOpening(moment(), week), timeZone) },
          'market closed, checks paused',
        );

  let wasOpen = marketOpen();
  logMarket(wasOpen);

  const job = new Cron(
    cronPattern(period, delay),
    {
      timezone: 'UTC',
      // A check that is still running is never started a second time.
      protect: true,
      catch: (err) => log.error({ err: err instanceof Error ? err.message : String(err) }, 'scheduled check crashed'),
    },
    async () => {
      const open = marketOpen();
      if (open !== wasOpen) {
        wasOpen = open;
        logMarket(open);
      }
      if (!open) return;

      await checkAndLog(deps);
      logNext();
    },
  );

  function logNext(): void {
    const next = job.nextRun();
    if (next) log.info({ next: formatLocal(next, timeZone) }, 'waiting for the next candle');
  }
  if (wasOpen) logNext();

  await new Promise<void>((resolve) => {
    if (stop.aborted) resolve();
    else stop.addEventListener('abort', () => resolve(), { once: true });
  });
  job.stop();
  while (job.isBusy()) await sleep(100);
}

/**
 * Entry point of the chart monitor, a separate process from the webhook server.
 *   npm run monitor        checks now, then after every candle close while the market trades
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

    // Also when the market is closed: catches up on signals from while the monitor was off.
    const result = await checkAndLog(deps);
    if (once) {
      process.exitCode = result.status === 'failed' ? 1 : 0;
      return;
    }
    if (!stop.aborted) await runSchedule(config, deps, stop);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
