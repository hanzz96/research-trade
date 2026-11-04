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

const isStopLabel = (text: string) => /^SL\b/.test(text);
const isTargetLabel = (text: string) => /^TP\b/.test(text);
const wasHit = (text: string) => text.includes('> HIT');

/**
 * Rebuilds the signals the indicator drew. Each signal is a pair of labels (SL and TP) that share
 * an x position with three lines: the dotted entry line and the dashed stop and target lines.
 * Signals come back oldest first.
 */
export function extractSignals(study: StudySnapshot): ChartSignal[] {
  const byX = new Map<number, { stop?: Label; target?: Label }>();
  for (const label of study.labels) {
    const slot = byX.get(label.x) ?? {};
    if (isStopLabel(label.text)) slot.stop = label;
    else if (isTargetLabel(label.text)) slot.target = label;
    byX.set(label.x, slot);
  }

  const signals: ChartSignal[] = [];
  for (const [x, { stop, target }] of byX) {
    if (!stop || !target) continue;
    const direction: Direction = target.price > stop.price ? 'BUY' : 'SELL';
    const entryLine = study.lines.find(
      (line) => line.x1 === x && line.style === 'dot' && line.y1 === line.y2,
    );
    signals.push({
      direction,
      entry: entryLine ? entryLine.y1 : null,
      stop: stop.price,
      target: target.price,
      hit: wasHit(stop.text) ? 'SL' : wasHit(target.text) ? 'TP' : null,
      key: `${direction}|${stop.price.toFixed(2)}|${target.price.toFixed(2)}`,
    });
  }
  return signals;
}
