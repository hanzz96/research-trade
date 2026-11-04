import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import { closedCandleOpen, cronPattern } from '../../src/chart-monitor/schedule.js';

const at = (iso: string) => new Date(iso);

/** The next `count` times a cron job with this pattern fires after `from`, in UTC. */
function runs(pattern: string, from: string, count: number): string[] {
  const job = new Cron(pattern, { timezone: 'UTC', paused: true });
  const times = job.nextRuns(count, at(from)).map((date) => date.toISOString());
  job.stop();
  return times;
}

describe('cronPattern', () => {
  it.each([
    [30, 60, '0 1,31 * * * *'],
    [15, 60, '0 1,16,31,46 * * * *'],
    [60, 60, '0 1 * * * *'],
    [30, 5, '5 0,30 * * * *'],
    [30, 90, '30 1,31 * * * *'],
    [1, 5, '5 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59 * * * *'],
  ])('for %i minute candles and a %i s delay is "%s"', (period, delay, expected) => {
    expect(cronPattern(period, delay)).toBe(expected);
  });

  it('wraps the delay past the hour for the last candle of the hour', () => {
    // 59 minutes of delay on 60-minute candles: fires at :59, not :00 of the next hour
    expect(cronPattern(60, 59 * 60)).toBe('0 59 * * * *');
    expect(cronPattern(30, 29 * 60 + 30)).toBe('30 29,59 * * * *');
  });

  it('makes croner fire one minute after each half hour, in order', () => {
    expect(runs(cronPattern(30, 60), '2026-11-04T08:38:32Z', 4)).toEqual([
      '2026-11-04T09:01:00.000Z',
      '2026-11-04T09:31:00.000Z',
      '2026-11-04T10:01:00.000Z',
      '2026-11-04T10:31:00.000Z',
    ]);
  });

  it('crosses midnight', () => {
    expect(runs(cronPattern(30, 60), '2026-11-04T23:45:00Z', 2)).toEqual([
      '2026-11-05T00:01:00.000Z',
      '2026-11-05T00:31:00.000Z',
    ]);
  });

  it('does not fire at the exact moment it is asked from', () => {
    expect(runs(cronPattern(30, 60), '2026-11-04T09:01:00Z', 1)).toEqual(['2026-11-04T09:31:00.000Z']);
  });
});

describe('closedCandleOpen', () => {
  it.each([
    ['2026-11-04T09:01:00Z', 30, 60, '2026-11-04T08:30:00.000Z'],
    ['2026-11-04T09:31:00Z', 30, 60, '2026-11-04T09:00:00.000Z'],
    ['2026-11-04T09:01:00.250Z', 30, 60, '2026-11-04T08:30:00.000Z'], // started a few ms late
    ['2026-11-05T00:01:00Z', 30, 60, '2026-11-04T23:30:00.000Z'], // previous day
    ['2026-11-04T10:01:00Z', 60, 60, '2026-11-04T09:00:00.000Z'],
    ['2026-11-04T09:16:00Z', 15, 60, '2026-11-04T09:00:00.000Z'],
    ['2026-11-04T09:30:05Z', 1, 5, '2026-11-04T09:29:00.000Z'],
  ])('a check fired at %s (%i min candles, %i s delay) is about the candle opened at %s', (firedAt, period, delay, expected) => {
    expect(closedCandleOpen(firedAt, period, delay).toISOString()).toBe(expected);
  });
});
