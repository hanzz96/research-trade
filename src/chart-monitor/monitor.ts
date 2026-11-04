import type { Notifier } from '../shared/discord.js';
import type { ChartSnapshot, StudySnapshot } from './chart-reader.js';
import type { MonitorConfig } from './config.js';
import type { PendingLog } from './fallback.js';
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
  /** Where an announced signal waits when the database refuses it. */
  fallback: PendingLog;
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
 *
 * If the message went out but the database refused the record, the signal is written to the
 * fallback file instead. Every check reads that file as well as the database: its keys count as
 * seen (so nothing is announced twice) and its entries are copied into the database, together
 * with any new signals, as soon as the database accepts them.
 */
export async function checkOnce(deps: MonitorDeps): Promise<CheckResult> {
  const { config, notifier, store, fallback, log } = deps;
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

  const pending = await fallback.read();
  if (pending.skipped > 0) {
    log.warn({ skipped: pending.skipped }, 'ignored damaged lines in the fallback file');
  }
  if (pending.entries.length > 0) {
    try {
      await store.recordAnnounced(
        pending.entries.map((entry) => ({ signal: entry.signal, announcedAt: new Date(entry.announcedAt) })),
      );
      await fallback.remove(new Set(pending.entries.map((entry) => entry.signal.key)));
      log.info({ count: pending.entries.length }, 'copied pending signals from the fallback file into the database');
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'could not copy pending signals into the database yet');
    }
  }

  // The file counts as seen too, whether or not the copy above worked.
  const seen = await store.seenKeys();
  for (const entry of pending.entries) seen.add(entry.signal.key);
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
    try {
      await store.recordAnnounced([{ signal, announcedAt: detectedAt }]);
    } catch (err) {
      // Already announced, so it must not be forgotten: keep it in the file for the next check.
      log.error({ err: errorMessage(err), key: signal.key }, 'could not record the signal in the database; keeping it in the fallback file');
      await fallback.append({ signal, announcedAt: detectedAt.toISOString() });
    }
    sent += 1;
    log.info({ direction: signal.direction, key: signal.key }, 'signal sent to Discord');
  }
  return { status: 'ok', newSignals: fresh.length, sent };
}
