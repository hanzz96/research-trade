import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import { GOLD_WEEK, isTradingCandle, nextOpening } from '../../src/chart-monitor/market.js';
import { closedCandleOpen, cronPattern } from '../../src/chart-monitor/schedule.js';

// 2026-11-02 is a Monday. All times below are WIB (+07:00) unless they end in Z.
describe('isTradingCandle (gold: Monday 05:00 to Saturday 05:00 WIB, nonstop)', () => {
  it.each([
    ['Mon 04:30, before the open', '2026-11-02T04:30:00+07:00', false],
    ['Mon 05:00, the first candle', '2026-11-02T05:00:00+07:00', true],
    ['Tue 05:30', '2026-11-03T05:30:00+07:00', true],
    ['Wed 05:00, no daily break', '2026-11-04T05:00:00+07:00', true],
    ['Wed 05:30, no daily break', '2026-11-04T05:30:00+07:00', true],
    ['Thu 23:30', '2026-11-05T23:30:00+07:00', true],
    ['Fri 12:00', '2026-11-06T12:00:00+07:00', true],
    ['Sat 04:30, the last candle', '2026-11-07T04:30:00+07:00', true],
    ['Sat 05:00, closed', '2026-11-07T05:00:00+07:00', false],
    ['Sat 12:00', '2026-11-07T12:00:00+07:00', false],
    ['Sun 12:00', '2026-11-08T12:00:00+07:00', false],
    ['Sun 23:30', '2026-11-08T23:30:00+07:00', false],
    ['next Mon 04:30', '2026-11-09T04:30:00+07:00', false],
    ['next Mon 05:00', '2026-11-09T05:00:00+07:00', true],
  ])('%s', (_name, time, expected) => {
    expect(isTradingCandle(time, GOLD_WEEK)).toBe(expected);
  });

  it('does not depend on the zone the time is written in', () => {
    expect(isTradingCandle('2026-11-01T22:00:00Z', GOLD_WEEK)).toBe(true); // Mon 05:00 WIB
    expect(isTradingCandle('2026-11-01T21:30:00Z', GOLD_WEEK)).toBe(false); // Mon 04:30 WIB
    expect(isTradingCandle('2026-11-06T21:30:00Z', GOLD_WEEK)).toBe(true); // Sat 04:30 WIB
    expect(isTradingCandle('2026-11-06T22:00:00Z', GOLD_WEEK)).toBe(false); // Sat 05:00 WIB
  });

  it('is always true for "always"', () => {
    expect(isTradingCandle('2026-11-07T12:00:00+07:00', 'always')).toBe(true);
  });
});

describe('nextOpening', () => {
  it.each([
    ['midweek', '2026-11-04T10:00:00+07:00', '2026-11-08T22:00:00.000Z'],
    ['Saturday after the close', '2026-11-07T06:00:00+07:00', '2026-11-08T22:00:00.000Z'],
    ['Sunday', '2026-11-08T12:00:00+07:00', '2026-11-08T22:00:00.000Z'],
    ['Monday before the open', '2026-11-02T04:00:00+07:00', '2026-11-01T22:00:00.000Z'],
    ['exactly at the open, so the following week', '2026-11-02T05:00:00+07:00', '2026-11-08T22:00:00.000Z'],
  ])('%s: the next Monday 05:00 WIB', (_name, now, expected) => {
    expect(nextOpening(now, GOLD_WEEK).toISOString()).toBe(expected);
  });
});

describe('the checks of a whole week', () => {
  it('run from the first candle after Monday 05:00 to the last one before Saturday 05:00, every 30 minutes', () => {
    const job = new Cron(cronPattern(30, 60), { timezone: 'UTC', paused: true });
    const fired = job.nextRuns(48 * 6, new Date('2026-11-01T00:00:00Z')); // Sunday 07:00 WIB to Saturday
    job.stop();

    const checked = fired
      .filter((time) => time < new Date('2026-11-07T00:00:00Z'))
      .filter((time) => isTradingCandle(closedCandleOpen(time, 30, 60), GOLD_WEEK))
      .map((time) => time.toISOString());

    // Mon 05:31 WIB (candle 05:00) ... Sat 05:01 WIB (candle 04:30, the last one of the week)
    expect(checked[0]).toBe('2026-11-01T22:31:00.000Z');
    expect(checked.at(-1)).toBe('2026-11-06T22:01:00.000Z');
    expect(checked).toHaveLength(240);
  });
});
