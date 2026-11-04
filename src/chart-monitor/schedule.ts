/**
 * Next moment to check the chart: shortly after a candle closes. Candles of a period that divides
 * the hour (15, 30, 60 minutes) open on UTC multiples of that period, so the close times are the
 * multiples too; `delaySeconds` gives the chart time to draw the new signal.
 */
export function nextRunAt(now: Date, periodMinutes: number, delaySeconds: number): Date {
  const periodMs = periodMinutes * 60_000;
  const delayMs = delaySeconds * 1000;
  const boundary = Math.floor(now.getTime() / periodMs) * periodMs;
  const sameSlot = boundary + delayMs;
  return new Date(sameSlot > now.getTime() ? sameSlot : boundary + periodMs + delayMs);
}
