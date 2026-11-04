import type { Notifier } from '../shared/discord.js';
import type { ChartSnapshot, StudySnapshot } from './chart-reader.js';
import type { MonitorConfig } from './config.js';
import { formatProblemNotice, formatRecoveryNotice, formatSignalNotice } from './format.js';
import { extractSignals } from './signals.js';
import { MAX_SEEN, type MonitorState, type StateStore } from './state.js';

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
  state: StateStore;
  log: Logger;
  now?: () => Date;
}

export type CheckResult =
  | { status: 'baseline'; signals: number }
  | { status: 'ok'; newSignals: number; sent: number }
  | { status: 'failed'; reason: string };

/** A "monitor is down" notice goes out after this many consecutive failed reads, then once. */
const FAILURES_BEFORE_NOTICE = 2;

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
 * announced as new. A signal is remembered only after its Discord message went out.
 */
export async function checkOnce(deps: MonitorDeps): Promise<CheckResult> {
  const { config, notifier, log } = deps;
  const detectedAt = (deps.now ?? (() => new Date()))();
  const context = {
    symbol: config.MONITOR_SYMBOL,
    timeframe: config.MONITOR_TIMEFRAME,
    timeZone: config.DISPLAY_TIMEZONE,
  };
  const state = await deps.state.load();

  let study: StudySnapshot;
  try {
    study = requireStudy(await deps.readChart(), config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    const failures = state.failures + 1;
    let alerted = state.alerted;
    if (failures >= FAILURES_BEFORE_NOTICE && !alerted) {
      try {
        await notifier.send(formatProblemNotice(reason, failures, context));
        alerted = true;
      } catch (sendErr) {
        log.error({ err: errorMessage(sendErr) }, 'could not send the monitor problem notice');
      }
    }
    await deps.state.save({ ...state, failures, alerted });
    log.warn({ reason, failures }, 'could not read the chart');
    return { status: 'failed', reason };
  }

  const next: MonitorState = { ...state, failures: 0, alerted: false };
  if (state.alerted) {
    try {
      await notifier.send(formatRecoveryNotice(context));
    } catch (sendErr) {
      log.error({ err: errorMessage(sendErr) }, 'could not send the recovery notice');
    }
  }

  const signals = extractSignals(study);

  if (!state.baselined) {
    await deps.state.save({
      ...next,
      baselined: true,
      seen: signals.map((signal) => signal.key).slice(-MAX_SEEN),
    });
    return { status: 'baseline', signals: signals.length };
  }

  const seen = new Set(state.seen);
  const fresh = signals.filter((signal) => !seen.has(signal.key));
  const sentKeys: string[] = [];
  let deliveryError: string | null = null;
  for (const signal of fresh) {
    try {
      await notifier.send(formatSignalNotice(signal, detectedAt, context));
      sentKeys.push(signal.key);
      log.info({ direction: signal.direction, key: signal.key }, 'signal sent to Discord');
    } catch (err) {
      // Leave it unseen so the next check retries it.
      deliveryError = errorMessage(err);
      log.error({ err: deliveryError, key: signal.key }, 'could not send the signal to Discord');
      break;
    }
  }

  await deps.state.save({ ...next, seen: [...state.seen, ...sentKeys].slice(-MAX_SEEN) });
  if (deliveryError) return { status: 'failed', reason: `Discord: ${deliveryError}` };
  return { status: 'ok', newSignals: fresh.length, sent: sentKeys.length };
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');
