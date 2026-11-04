import moment from 'moment-timezone';

/** A weekly trading window: it opens and closes at fixed times of the week in one time zone. */
export interface TradingWeek {
  timeZone: string;
  /** ISO weekday (1 = Monday ... 7 = Sunday) and "HH:mm" in `timeZone`. */
  opens: { isoWeekday: number; time: string };
  closes: { isoWeekday: number; time: string };
}

/**
 * XAU/USD as the schedule was given, in WIB: Monday 05:00 to Saturday 05:00, nonstop (Tuesday to
 * Thursday have no break). WIB has no daylight saving, while the broker's real hours move by an hour
 * with US daylight saving, so this window is the looser one all year: it may include an hour in
 * which no candle forms, but it never leaves out one that does. Holidays are not handled.
 */
export const GOLD_WEEK: TradingWeek = {
  timeZone: 'Asia/Jakarta',
  opens: { isoWeekday: 1, time: '05:00' },
  closes: { isoWeekday: 6, time: '05:00' },
};

const MINUTES_PER_DAY = 24 * 60;

function minuteOfWeek(isoWeekday: number, hours: number, minutes: number): number {
  return (isoWeekday - 1) * MINUTES_PER_DAY + hours * 60 + minutes;
}

function minuteOfWeekAt({ isoWeekday, time }: TradingWeek['opens']): number {
  const [hours, minutes] = time.split(':').map(Number);
  return minuteOfWeek(isoWeekday, hours ?? 0, minutes ?? 0);
}

/** Whether a candle that opened at this moment belongs to the trading week. */
export function isTradingCandle(candleOpen: moment.MomentInput, week: TradingWeek | 'always'): boolean {
  if (week === 'always') return true;
  const local = moment.tz(candleOpen, week.timeZone);
  const minute = minuteOfWeek(local.isoWeekday(), local.hours(), local.minutes());
  return minute >= minuteOfWeekAt(week.opens) && minute < minuteOfWeekAt(week.closes);
}

/** The next moment the market opens after `now`. */
export function nextOpening(now: moment.MomentInput, week: TradingWeek): Date {
  const local = moment.tz(now, week.timeZone);
  const [hours, minutes] = week.opens.time.split(':').map(Number);
  const opening = local
    .clone()
    .isoWeekday(week.opens.isoWeekday)
    .startOf('day')
    .hours(hours ?? 0)
    .minutes(minutes ?? 0);
  if (!opening.isAfter(local)) opening.add(1, 'week');
  return opening.toDate();
}
