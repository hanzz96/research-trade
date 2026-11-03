import type { SignalRecord } from './store.js';

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

function formatTime(iso: string, timeZone: string): string {
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

const HTF_LABEL = { '1': 'BULLISH', '-1': 'BEARISH', '0': 'NEUTRAL / filter off' } as const;

export function formatSignalMessage(signal: SignalRecord, timeZone: string): string {
  const { price, indicators, levels, htf } = signal.snapshot;
  return [
    `**${displaySymbol(signal.symbol)} — ${signal.direction} CANDIDATE** (${displayTimeframe(signal.timeframe)})`,
    `Candle open: ${formatTime(signal.candleTimestamp, timeZone)} (${timeZone})`,
    `Price: ${price.toFixed(2)}`,
    '',
    '**Strategy**',
    `• EMA fast / slow: ${indicators.ema_fast.toFixed(2)} / ${indicators.ema_slow.toFixed(2)}`,
    `• RSI: ${indicators.rsi.toFixed(1)}`,
    `• MACD: ${indicators.macd.toFixed(2)} | signal ${indicators.macd_signal.toFixed(2)} | histogram ${indicators.macd_histogram.toFixed(2)}`,
    `• ATR: ${indicators.atr.toFixed(2)}`,
    `• Swing low / high: ${levels.swing_low.toFixed(2)} / ${levels.swing_high.toFixed(2)}`,
    `• Higher-timeframe trend: ${HTF_LABEL[String(htf.trend) as keyof typeof HTF_LABEL]}`,
    '',
    'Status: NEEDS_INPUT — trade plan, position size and risk validation are not implemented in this version.',
    '⚠️ Alert-only. Verify broker price, spread and all parameters before any trading decision.',
  ].join('\n');
}
