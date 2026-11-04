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

export function formatTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
