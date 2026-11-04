import { describe, expect, it } from 'vitest';
import { extractSignals } from '../../src/chart-monitor/signals.js';
import { BUY_A, BUY_B, SELL_C, combine, drawSignal } from './support.js';

describe('extractSignals', () => {
  it('reads a BUY with its exact entry from the dotted line', () => {
    const [signal] = extractSignals(BUY_A);
    expect(signal).toEqual({
      direction: 'BUY',
      entry: 3952.56,
      stop: 3911.83267296,
      target: 4013.65099057,
      hit: null,
      key: 'BUY|3911.83|4013.65',
    });
  });

  it('calls it a SELL when the target is below the stop, and notes a stop that was hit', () => {
    const [signal] = extractSignals(SELL_C);
    expect(signal).toMatchObject({ direction: 'SELL', entry: 3920.6, hit: 'SL' });
  });

  it('notes a target that was hit', () => {
    expect(extractSignals(BUY_B)[0]).toMatchObject({ hit: 'TP' });
  });

  it('returns signals oldest first', () => {
    const signals = extractSignals(combine(SELL_C, BUY_A, BUY_B));
    expect(signals.map((signal) => signal.direction)).toEqual(['SELL', 'BUY', 'BUY']);
  });

  it('keeps the entry empty when the dotted line is missing', () => {
    const [signal] = extractSignals(drawSignal({ x: 2, stop: 3900, target: 3990 }));
    expect(signal?.entry).toBeNull();
  });

  it('skips a label without its partner and ignores other labels', () => {
    const study = combine(BUY_A);
    study.labels.push({ x: 120, text: 'SL 3900  -$40', price: 3900 });
    study.labels.push({ x: 122, text: 'something else', price: 4000 });
    expect(extractSignals(study)).toHaveLength(1);
  });

  it('gives different keys to different directions and levels', () => {
    const keys = extractSignals(combine(SELL_C, BUY_A, BUY_B)).map((signal) => signal.key);
    expect(new Set(keys).size).toBe(3);
  });
});
