import moment from 'moment-timezone';

/**
 * Next moment to check the chart: shortly after a candle closes. Candles of a period that divides
 * the hour (15, 30, 60 minutes) open on UTC minutes that are multiples of that period, so the close
 * times are those minutes too; `delaySeconds` gives the chart time to draw the new signal.
 * Only periods that divide 60 are supported (the config enforces it): a period like 45 does not
 * line up with the hour, so its slots would be wrong.
 */
export function nextRunAt(now: moment.MomentInput, periodMinutes: number, delaySeconds: number): Date {
  const current = moment.utc(now);
  const slotStart = current
    .clone()
    .startOf('hour')
    .add(Math.floor(current.minutes() / periodMinutes) * periodMinutes, 'minutes');

  const sameSlot = slotStart.clone().add(delaySeconds, 'seconds');
  if (sameSlot.isAfter(current)) return sameSlot.toDate();
  return slotStart.add(periodMinutes, 'minutes').add(delaySeconds, 'seconds').toDate();
}
