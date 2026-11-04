import moment from 'moment-timezone';
import type { Notifier } from '../shared/discord.js';
import { toIsoString } from '../shared/time.js';
import type { ChartSnapshot, StudySnapshot } from './chart-reader.js';
import type { MonitorConfig } from './config.js';
import type { PendingLog } from './fallback.js';
import {
  formatProblemNotice,
  formatRecoveryNotice,
  formatSignalNotice,
  type NoticeContext,
} from './format.js';
import { extractSignals, type ChartSignal } from './signals.js';
import type { MonitorHealth, MonitorStore } from './store.js';

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

const noticeContext = (config: MonitorDeps['config']): NoticeContext => ({
  symbol: config.MONITOR_SYMBOL,
  timeframe: config.MONITOR_TIMEFRAME,
  timeZone: config.DISPLAY_TIMEZONE,
});

/**
 * Sends a notice about the monitor itself. A notice is not worth stopping a check for, so a
 * failure is only logged. Returns whether it went out.
 */
async function sendNotice(deps: MonitorDeps, message: string, what: string): Promise<boolean> {
  try {
    await deps.notifier.send(message);
    return true;
  } catch (err) {
    deps.log.error({ err: errorMessage(err) }, `could not send the ${what}`);
    return false;
  }
}

/** The chart could not be read: count it, and send the "monitor is down" notice once enough pile up. */
async function recordReadFailure(
  deps: MonitorDeps,
  health: MonitorHealth,
  context: NoticeContext,
  reason: string,
): Promise<CheckResult> {
  const failures = health.failures + 1;
  let alerted = health.alerted;
  if (failures >= FAILURES_BEFORE_NOTICE && !alerted) {
    alerted = await sendNotice(deps, formatProblemNotice(reason, failures, context), 'monitor problem notice');
  }
  await deps.store.saveHealth({ failures, alerted });
  deps.log.warn({ reason, failures }, 'could not read the chart');
  return { status: 'failed', reason };
}

/** The chart was read: if the monitor had been failing, say it recovered and reset the count. */
async function settleHealth(deps: MonitorDeps, health: MonitorHealth, context: NoticeContext): Promise<void> {
  if (health.failures === 0 && !health.alerted) return;
  if (health.alerted) await sendNotice(deps, formatRecoveryNotice(context), 'recovery notice');
  await deps.store.saveHealth({ failures: 0, alerted: false });
}

/**
 * Copies the signals waiting in the fallback file into the database. Returns their keys: they
 * count as seen whether or not the copy worked, so nothing is announced twice.
 */
async function flushPending(deps: MonitorDeps): Promise<Set<string>> {
  const { store, fallback, log } = deps;
  const { entries, skipped } = await fallback.read();
  if (skipped > 0) log.warn({ skipped }, 'ignored damaged lines in the fallback file');

  const keys = new Set(entries.map((entry) => entry.signal.key));
  if (entries.length === 0) return keys;

  try {
    await store.recordAnnounced(
      entries.map((entry) => ({ signal: entry.signal, announcedAt: moment(entry.announcedAt).toDate() })),
    );
    await fallback.remove(keys);
    log.info({ count: entries.length }, 'copied pending signals from the fallback file into the database');
  } catch (err) {
    log.warn({ err: errorMessage(err) }, 'could not copy pending signals into the database yet');
  }
  return keys;
}

/**
 * Sends one signal to Discord, then remembers it. If the database refuses the record, the signal
 * goes to the fallback file instead, because it was announced and must not be forgotten.
 * Returns null when delivered, or why Discord refused it (the signal is then retried next check).
 */
async function announce(
  deps: MonitorDeps,
  signal: ChartSignal,
  detectedAt: Date,
  context: NoticeContext,
): Promise<string | null> {
  const { notifier, store, fallback, log } = deps;
  try {
    await notifier.send(formatSignalNotice(signal, detectedAt, context));
  } catch (err) {
    const reason = errorMessage(err);
    log.error({ err: reason, key: signal.key }, 'could not send the signal to Discord');
    return `Discord: ${reason}`;
  }

  try {
    await store.recordAnnounced([{ signal, announcedAt: detectedAt }]);
  } catch (err) {
    log.error(
      { err: errorMessage(err), key: signal.key },
      'could not record the signal in the database; keeping it in the fallback file',
    );
    await fallback.append({ signal, announcedAt: toIsoString(detectedAt) });
  }
  log.info({ direction: signal.direction, key: signal.key }, 'signal sent to Discord');
  return null;
}

/**
 * One check: read the chart, announce signals not seen before, remember them.
 * The first successful read only records what is already on the chart, so old signals are never
 * announced as new. A signal is remembered right after its Discord message was delivered, so a
 * failed send is retried at the next check.
 *
 * If the message went out but the database refused the record, the signal is written to the
 * fallback file instead. Every check reads that file as well as the database: its keys count as
 * seen (so nothing is announced twice) and its entries are copied into the database, before new
 * signals are announced, as soon as the database accepts them.
 */
export async function checkOnce(deps: MonitorDeps): Promise<CheckResult> {
  const { config, store } = deps;
  const detectedAt = (deps.now ?? (() => moment().toDate()))();
  const context = noticeContext(config);
  const health = await store.loadHealth();

  let study: StudySnapshot;
  try {
    study = requireStudy(await deps.readChart(), config);
  } catch (err) {
    return recordReadFailure(deps, health, context, errorMessage(err));
  }
  await settleHealth(deps, health, context);

  const signals = extractSignals(study);
  if (!health.baselined) {
    await store.recordBaseline(signals);
    return { status: 'baseline', signals: signals.length };
  }

  // Signals waiting in the fallback file were already announced, so they are not new either.
  const pendingKeys = await flushPending(deps);
  const seen = await store.seenKeys();
  const fresh = signals.filter((signal) => !seen.has(signal.key) && !pendingKeys.has(signal.key));

  for (const signal of fresh) {
    const failure = await announce(deps, signal, detectedAt, context);
    if (failure !== null) return { status: 'failed', reason: failure };
  }
  return { status: 'ok', newSignals: fresh.length, sent: fresh.length };
}
