import type { Notifier } from '../shared/discord.js';
import type { ChartSnapshot, StudySnapshot } from './chart-reader.js';
import type { MonitorConfig } from './config.js';
import { formatProblemNotice, formatRecoveryNotice, formatSignalNotice } from './format.js';
import { extractSignals } from './signals.js';
import type { MonitorStore } from './store.js';

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface MonitorDeps {
  config: Pick<
    MonitorConfig,
    'MONITOR_SYMBOL' | 'MONITOR_TIMEFRAME' | 'MONITOR_STUDY' | 'DISPLAY_TIMEZONE'
  >;
  readChart: () => Promise<ChartSnapshot>;
  notifier: Notifier;
  store: MonitorStore;
  log: Logger;
  now?: () => Date;
}

export type CheckResult =
  | { status: 'baseline'; signals: number }
  | { status: 'ok'; newSignals: number; sent: number }
  | { status: 'failed'; reason: string };

/** A "monitor is down" notice goes out after this many consecutive failed reads, then once. */
const FAILURES_BEFORE_NOTICE = 2;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');

/** The chart must show the expected symbol and timeframe with the indicator on it. */
function requireStudy(snapshot: ChartSnapshot, config: MonitorDeps['config']): StudySnapshot {
  if (snapshot.error) throw new Error(`the chart page reported an error: ${snapshot.error}`);
  if (!snapshot.symbol?.toUpperCase().includes(config.MONITOR_SYMBOL)) {
    throw new Error(`the chart shows ${snapshot.symbol ?? 'no symbol'}, expected ${config.MONITOR_SYMBOL}`);
  }
  if (snapshot.resolution !== config.MONITOR_TIMEFRAME) {
    throw new Error(`the chart timeframe is ${snapshot.resolution ?? 'unknown'}, expected ${config.MONITOR_TIMEFRAME}`);
  }
  if (!snapshot.study) {
    throw new Error(`the indicator "${config.MONITOR_STUDY}" is not on the chart`);
  }
  return snapshot.study;
}

/**
 * One check: read the chart, announce signals not seen before, remember them.
 * The first successful read only records what is already on the chart, so old signals are never
 * announced as new. A signal is remembered right after its Discord message was delivered, so a
 * failed send is retried at the next check.
 */
export async function checkOnce(deps: MonitorDeps): Promise<CheckResult> {
  const { config, notifier, store, log } = deps;
  const detectedAt = (deps.now ?? (() => new Date()))();
  const context = {
    symbol: config.MONITOR_SYMBOL,
    timeframe: config.MONITOR_TIMEFRAME,
    timeZone: config.DISPLAY_TIMEZONE,
  };
  const health = await store.loadHealth();

  let study: StudySnapshot;
  try {
    study = requireStudy(await deps.readChart(), config);
  } catch (err) {
    const reason = errorMessage(err);
    const failures = health.failures + 1;
    let alerted = health.alerted;
    if (failures >= FAILURES_BEFORE_NOTICE && !alerted) {
      try {
        await notifier.send(formatProblemNotice(reason, failures, context));
        alerted = true;
      } catch (sendErr) {
        log.error({ err: errorMessage(sendErr) }, 'could not send the monitor problem notice');
      }
    }
    await store.saveHealth({ failures, alerted });
    log.warn({ reason, failures }, 'could not read the chart');
    return { status: 'failed', reason };
  }

  if (health.failures > 0 || health.alerted) {
    if (health.alerted) {
      try {
        await notifier.send(formatRecoveryNotice(context));
      } catch (sendErr) {
        log.error({ err: errorMessage(sendErr) }, 'could not send the recovery notice');
      }
    }
    await store.saveHealth({ failures: 0, alerted: false });
  }

  const signals = extractSignals(study);

  if (!health.baselined) {
    await store.recordBaseline(signals);
    return { status: 'baseline', signals: signals.length };
  }

  const seen = await store.seenKeys();
  const fresh = signals.filter((signal) => !seen.has(signal.key));
  let sent = 0;
  for (const signal of fresh) {
    try {
      await notifier.send(formatSignalNotice(signal, detectedAt, context));
    } catch (err) {
      // Leave it unremembered so the next check retries it.
      const reason = errorMessage(err);
      log.error({ err: reason, key: signal.key }, 'could not send the signal to Discord');
      return { status: 'failed', reason: `Discord: ${reason}` };
    }
    await store.recordAnnounced(signal);
    sent += 1;
    log.info({ direction: signal.direction, key: signal.key }, 'signal sent to Discord');
  }
  return { status: 'ok', newSignals: fresh.length, sent };
}
