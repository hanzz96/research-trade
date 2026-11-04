import moment from 'moment-timezone';

/**
 * Cron pattern (with a seconds field) that fires shortly after each candle closes. Candles of a
 * period that divides the hour (15, 30, 60 minutes) close on UTC minutes that are multiples of the
 * period; `delaySeconds` gives the chart time to draw the new signal. For 30 minutes and 60 seconds
 * the pattern is "0 1,31 * * * *". The delay has to be shorter than the period (the config checks it).
 */
export function cronPattern(periodMinutes: number, delaySeconds: number): string {
  const second = delaySeconds % 60;
  const minuteOffset = Math.floor(delaySeconds / 60);
  const minutes: number[] = [];
  for (let minute = 0; minute < 60; minute += periodMinutes) minutes.push((minute + minuteOffset) % 60);
  return `${second} ${minutes.sort((a, b) => a - b).join(',')} * * * *`;
}

/**
 * Open time of the candle that closed just before a check fired at `firedAt`. The delay is taken
 * off first, so a run that starts a few milliseconds late still lands on the right candle.
 */
export function closedCandleOpen(firedAt: moment.MomentInput, periodMinutes: number, delaySeconds: number): Date {
  const shifted = moment.utc(firedAt).subtract(delaySeconds, 'seconds');
  const closedAt = shifted
    .clone()
    .startOf('hour')
    .add(Math.floor(shifted.minutes() / periodMinutes) * periodMinutes, 'minutes');
  return closedAt.subtract(periodMinutes, 'minutes').toDate();
}
