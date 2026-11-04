import { describe, expect, it } from 'vitest';
import { nextRunAt } from '../../src/chart-monitor/schedule.js';

const at = (time: string) => new Date(`2026-11-04T${time}Z`);
const next = (time: string, period = 30, delay = 60) => nextRunAt(at(time), period, delay).toISOString();

describe('nextRunAt', () => {
  it('waits for one minute after the next half hour', () => {
    expect(next('08:38:32')).toBe('2026-11-04T09:01:00.000Z');
  });

  it('still uses the same slot when called just after the candle closes', () => {
    expect(next('09:00:30')).toBe('2026-11-04T09:01:00.000Z');
    expect(next('09:30:59')).toBe('2026-11-04T09:31:00.000Z');
  });

  it('moves to the following slot once the delay has passed', () => {
    expect(next('09:01:00')).toBe('2026-11-04T09:31:00.000Z');
    expect(next('09:20:00')).toBe('2026-11-04T09:31:00.000Z');
  });

  it('follows the candle length', () => {
    expect(next('08:38:32', 60)).toBe('2026-11-04T09:01:00.000Z');
    expect(next('08:38:32', 15)).toBe('2026-11-04T08:46:00.000Z');
  });

  it('crosses midnight', () => {
    expect(next('23:45:00')).toBe('2026-11-05T00:01:00.000Z');
  });
});
