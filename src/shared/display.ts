import moment from 'moment-timezone';

export function displaySymbol(symbol: string): string {
  const match = /^([A-Z]{3})([A-Z]{3})$/.exec(symbol.toUpperCase());
  return match ? `${match[1]}/${match[2]}` : symbol;
}

/** TradingView interval ("15", "60", "1D", "1W", "1M") -> trader notation (M15, H1, D1, W1, MN1). */
export function displayTimeframe(timeframe: string): string {
  if (/^\d+$/.test(timeframe)) {
    const minutes = Number(timeframe);
    return minutes >= 60 && minutes % 60 === 0 ? `H${minutes / 60}` : `M${minutes}`;
  }
  const match = /^(\d*)([DWM])$/i.exec(timeframe);
  if (!match) return timeframe;
  const count = match[1] || '1';
  const unit = match[2]!.toUpperCase();
  return unit === 'M' ? `MN${count}` : `${unit}${count}`;
}

/** Local date and time in the given IANA time zone, e.g. "2026-11-04 16:01". */
export function formatTime(value: moment.MomentInput, timeZone: string): string {
  const parsed = moment.tz(value, timeZone);
  if (!parsed.isValid()) throw new RangeError(`not a valid date: ${String(value)}`);
  return parsed.format('YYYY-MM-DD HH:mm');
}
