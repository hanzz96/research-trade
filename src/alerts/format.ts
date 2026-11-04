import { displaySymbol, displayTimeframe, formatTime } from '../shared/display.js';
import type { SignalRecord } from './store.js';

const HTF_LABEL = { '1': 'BULLISH', '-1': 'BEARISH', '0': 'NEUTRAL / filter off' } as const;

/** Indicative levels from the indicator. Risk is per ounce; 0.01 lot of XAUUSD is 1 oz at FBS. */
function planLines(price: number, plan: SignalRecord['snapshot']['plan']): string[] {
  if (!plan) return [];
  const risk = Math.abs(price - plan.stop);
  const reward = Math.abs(plan.target - price);
  return [
    '',
    '**Levels (indicative)**',
    `• Entry ${price.toFixed(2)} | stop ${plan.stop.toFixed(2)} | target ${plan.target.toFixed(2)}`,
    `• Risk ${risk.toFixed(2)} USD per oz (about ${risk.toFixed(2)} USD at 0.01 lot) | reward ${reward.toFixed(2)} | 1:${(reward / risk).toFixed(1)}`,
  ];
}

export function formatSignalMessage(signal: SignalRecord, timeZone: string): string {
  const { price, indicators, levels, htf, plan } = signal.snapshot;
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
    ...planLines(price, plan),
    '',
    plan
      ? 'Status: NEEDS_INPUT — position size and risk validation are not implemented in this version.'
      : 'Status: NEEDS_INPUT — trade plan, position size and risk validation are not implemented in this version.',
    '⚠️ Alert-only. Verify broker price, spread and all parameters before any trading decision.',
  ].join('\n');
}
