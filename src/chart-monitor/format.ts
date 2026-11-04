import { displaySymbol, displayTimeframe, formatTime } from '../shared/display.js';
import type { ChartSignal } from './signals.js';

export interface NoticeContext {
  symbol: string;
  timeframe: string;
  timeZone: string;
}

const fixed = (value: number) => value.toFixed(2);

/** The price lines of a signal. Without the entry line only the levels are known, so no risk figures. */
function levelLines({ entry, stop, target }: ChartSignal): string[] {
  if (entry === null) return [`SL ${fixed(stop)} | TP ${fixed(target)}`];

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return [
    `Entry ${fixed(entry)} | SL ${fixed(stop)} | TP ${fixed(target)}`,
    // 0,01 lot of XAUUSD is 1 oz at FBS, so the risk per oz is also the risk at 0,01 lot.
    `Risiko ${fixed(risk)} USD per oz (sekitar ${fixed(risk)} USD di 0,01 lot) | reward ${fixed(reward)} | 1:${(reward / risk).toFixed(1)}`,
  ];
}

/** Discord message for a signal read from the chart. Same facts as the webhook alert, in Indonesian. */
export function formatSignalNotice(signal: ChartSignal, detectedAt: Date, context: NoticeContext): string {
  return [
    `**${displaySymbol(context.symbol)} — ${signal.direction} CANDIDATE** (${displayTimeframe(context.timeframe)})`,
    `Terdeteksi: ${formatTime(detectedAt.toISOString(), context.timeZone)} (${context.timeZone})`,
    ...levelLines(signal),
    ...(signal.hit ? [`Catatan: harga sudah menyentuh ${signal.hit} saat sinyal ini terbaca.`] : []),
    'Sumber: pemantauan chart TradingView, bukan alert webhook.',
    '⚠️ Alert-only. Cek harga broker, spread, dan semua parameter sebelum keputusan apa pun.',
  ].join('\n');
}

export function formatProblemNotice(reason: string, failures: number, context: NoticeContext): string {
  return [
    `⚠️ **Pemantauan ${displaySymbol(context.symbol)} ${displayTimeframe(context.timeframe)} bermasalah**`,
    `Gagal membaca chart TradingView ${failures} kali berturut-turut: ${reason}`,
    'Sinyal tidak akan terkirim sampai ini pulih.',
  ].join('\n');
}

export function formatRecoveryNotice(context: NoticeContext): string {
  return `✅ Pemantauan ${displaySymbol(context.symbol)} ${displayTimeframe(context.timeframe)} pulih dan membaca chart lagi.`;
}
