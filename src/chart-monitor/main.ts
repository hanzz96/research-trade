import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { DiscordNotifier } from '../shared/discord.js';
import { evaluateInChart } from './cdp.js';
import { readChart } from './chart-reader.js';
import { loadMonitorConfig } from './config.js';
import { checkOnce, type CheckResult } from './monitor.js';
import { nextRunAt } from './schedule.js';
import { FileStateStore } from './state.js';

/**
 * Entry point of the chart monitor, a separate process from the webhook server.
 *   npm run monitor        checks after every candle close until stopped
 *   npm run monitor:once   one check, then exit (for cron or launchd); exit code 1 on failure
 */
async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = loadMonitorConfig();
  const log = pino({ redact: ['webhookUrl', 'DISCORD_WEBHOOK_URL'] });

  const deps = {
    config,
    log,
    notifier: new DiscordNotifier(config.DISCORD_WEBHOOK_URL),
    state: new FileStateStore(config.MONITOR_STATE_FILE),
    readChart: () =>
      readChart(
        (expression) => evaluateInChart({ host: config.CDP_HOST, port: config.CDP_PORT }, expression),
        config.MONITOR_STUDY,
      ),
  };

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());

  while (!stop.signal.aborted) {
    let result: CheckResult;
    try {
      result = await checkOnce(deps);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      log.error({ err: reason }, 'check crashed');
      result = { status: 'failed', reason };
    }
    log.info(result, 'check finished');

    if (once) {
      process.exitCode = result.status === 'failed' ? 1 : 0;
      return;
    }

    const next = nextRunAt(new Date(), Number(config.MONITOR_TIMEFRAME), config.MONITOR_DELAY_SECONDS);
    log.info({ next: next.toISOString() }, 'waiting for the next candle');
    try {
      await sleep(next.getTime() - Date.now(), undefined, { signal: stop.signal });
    } catch {
      break; // stopped while waiting
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
