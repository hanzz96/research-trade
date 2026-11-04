import type { ChartSnapshot, StudySnapshot } from '../../src/chart-monitor/chart-reader.js';
import type { ChartSignal } from '../../src/chart-monitor/signals.js';
import type { MonitorHealth, MonitorStore } from '../../src/chart-monitor/store.js';
import type { Notifier } from '../../src/shared/discord.js';

interface SignalDrawing {
  x: number;
  entry?: number;
  stop: number;
  target: number;
  stopText?: string;
  targetText?: string;
}

/** Labels and lines the indicator draws for one signal (values taken from a real chart read). */
export function drawSignal({ x, entry, stop, target, stopText, targetText }: SignalDrawing): StudySnapshot {
  return {
    name: 'XAUUSD Entry Reminder',
    labels: [
      { x, text: stopText ?? `SL ${Math.round(stop)}  -$40 (over budget)`, price: stop },
      { x, text: targetText ?? `TP ${Math.round(target)}  +$60`, price: target },
    ],
    lines: [
      ...(entry === undefined ? [] : [{ x1: x, y1: entry, y2: entry, style: 'dot' }]),
      { x1: x, y1: stop, y2: stop, style: 'dsh' },
      { x1: x, y1: target, y2: target, style: 'dsh' },
    ],
  };
}

export function combine(...drawings: StudySnapshot[]): StudySnapshot {
  return {
    name: 'XAUUSD Entry Reminder',
    labels: drawings.flatMap((drawing) => drawing.labels),
    lines: drawings.flatMap((drawing) => drawing.lines),
  };
}

export const BUY_A = drawSignal({ x: 98, entry: 3952.56, stop: 3911.83267296, target: 4013.65099057 });
export const BUY_B = drawSignal({
  x: 100,
  entry: 3951.94,
  stop: 3913.52379305,
  target: 4009.56431042,
  targetText: 'TP 4010  +$57.6  > HIT',
});
export const SELL_C = drawSignal({
  x: 96,
  entry: 3920.6,
  stop: 3961.68199547,
  target: 3858.9770068,
  stopText: 'SL 3962  -$41.1 (over budget)  > HIT',
});

export const snapshotOf = (
  study: StudySnapshot | null,
  overrides: Partial<ChartSnapshot> = {},
): ChartSnapshot => ({
  symbol: 'OANDA:XAUUSD',
  resolution: '30',
  study,
  ...overrides,
});

export class FakeNotifier implements Notifier {
  readonly sent: string[] = [];
  failNext = 0;

  async send(content: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('discord responded with HTTP 503');
    }
    this.sent.push(content);
  }
}

/** In-memory MonitorStore: the same behaviour as the Postgres one, for the check-flow tests. */
export class MemoryStore implements MonitorStore {
  health: MonitorHealth = { baselined: false, failures: 0, alerted: false };
  readonly signals = new Map<string, 'baseline' | 'announced'>();

  async loadHealth(): Promise<MonitorHealth> {
    return { ...this.health };
  }

  async saveHealth({ failures, alerted }: Pick<MonitorHealth, 'failures' | 'alerted'>): Promise<void> {
    this.health = { ...this.health, failures, alerted };
  }

  async seenKeys(): Promise<Set<string>> {
    return new Set(this.signals.keys());
  }

  async recordBaseline(signals: readonly ChartSignal[]): Promise<void> {
    for (const signal of signals) if (!this.signals.has(signal.key)) this.signals.set(signal.key, 'baseline');
    this.health = { ...this.health, baselined: true };
  }

  async recordAnnounced(signal: ChartSignal): Promise<void> {
    if (!this.signals.has(signal.key)) this.signals.set(signal.key, 'announced');
  }
}

export const silentLog = { info() {}, warn() {}, error() {} };

export const monitorConfig = {
  MONITOR_SYMBOL: 'XAUUSD',
  MONITOR_TIMEFRAME: '30',
  MONITOR_STUDY: 'XAUUSD Entry Reminder',
  DISPLAY_TIMEZONE: 'Asia/Jakarta',
};
