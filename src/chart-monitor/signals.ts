import type { StudySnapshot } from './chart-reader.js';

export type Direction = 'BUY' | 'SELL';

export interface ChartSignal {
  direction: Direction;
  /** Close of the signal candle (the dotted line the indicator draws), when the line is present. */
  entry: number | null;
  stop: number;
  target: number;
  /** Which level price had already touched when the signal was read, if any. */
  hit: 'SL' | 'TP' | null;
  /**
   * Identity of a signal across reads. The chart's own x positions are not stable between reads,
   * but the stop and target prices of one signal are fixed by the candle it fired on.
   */
  key: string;
}

type Label = StudySnapshot['labels'][number];
type Line = StudySnapshot['lines'][number];

/** The SL and TP labels the indicator draws for one signal, at the same horizontal position. */
interface LabelPair {
  x: number;
  stop: Label;
  target: Label;
}

const isStopLabel = (text: string) => /^SL\b/.test(text);
const isTargetLabel = (text: string) => /^TP\b/.test(text);
const wasHit = (text: string) => text.includes('> HIT');

/** Groups the SL and TP labels by position, oldest first. A signal missing either label is left out. */
function pairLabels(labels: readonly Label[]): LabelPair[] {
  const byX = new Map<number, { stop?: Label; target?: Label }>();
  for (const label of labels) {
    const slot = byX.get(label.x) ?? {};
    if (isStopLabel(label.text)) slot.stop = label;
    else if (isTargetLabel(label.text)) slot.target = label;
    byX.set(label.x, slot);
  }
  return [...byX].flatMap(([x, { stop, target }]) => (stop && target ? [{ x, stop, target }] : []));
}

/** The dotted line at the same position is the entry; the dashed ones repeat the stop and target. */
function findEntry(lines: readonly Line[], x: number): number | null {
  const entryLine = lines.find((line) => line.x1 === x && line.style === 'dot' && line.y1 === line.y2);
  return entryLine ? entryLine.y1 : null;
}

function hitLevel(stop: Label, target: Label): ChartSignal['hit'] {
  if (wasHit(stop.text)) return 'SL';
  return wasHit(target.text) ? 'TP' : null;
}

function toSignal({ x, stop, target }: LabelPair, lines: readonly Line[]): ChartSignal {
  const direction: Direction = target.price > stop.price ? 'BUY' : 'SELL';
  return {
    direction,
    entry: findEntry(lines, x),
    stop: stop.price,
    target: target.price,
    hit: hitLevel(stop, target),
    key: `${direction}|${stop.price.toFixed(2)}|${target.price.toFixed(2)}`,
  };
}

/**
 * Rebuilds the signals the indicator drew on the chart. The indicator stores no data, only
 * drawings: each signal is an SL label and a TP label at one position, plus three lines there.
 * Signals come back oldest first.
 */
export function extractSignals(study: StudySnapshot): ChartSignal[] {
  return pairLabels(study.labels).map((pair) => toSignal(pair, study.lines));
}
