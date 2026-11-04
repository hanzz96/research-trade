import { displaySymbol, displayTimeframe, formatTime } from '../shared/display.js';
import type { ChartSignal } from './signals.js';

interface Context {
  symbol: string;
  timeframe: string;
  timeZone: string;
}

const fixed = (value: number) => value.toFixed(2);

/** Discord message for a signal read from the chart. Same facts as the webhook alert, in Indonesian. */
export function formatSignalNotice(signal: ChartSignal, detectedAt: Date, context: Context): string {
  const lines = [
    `**${displaySymbol(context.symbol)} — ${signal.direction} CANDIDATE** (${displayTimeframe(context.timeframe)})`,
    `Terdeteksi: ${formatTime(detectedAt.toISOString(), context.timeZone)} (${context.timeZone})`,
  ];

  if (signal.entry === null) {
    lines.push(`SL ${fixed(signal.stop)} | TP ${fixed(signal.target)}`);
  } else {
    const risk = Math.abs(signal.entry - signal.stop);
    const reward = Math.abs(signal.target - signal.entry);
    lines.push(
      `Entry ${fixed(signal.entry)} | SL ${fixed(signal.stop)} | TP ${fixed(signal.target)}`,
      // 0,01 lot of XAUUSD is 1 oz at FBS, so the risk per oz is also the risk at 0,01 lot.
      `Risiko ${fixed(risk)} USD per oz (sekitar ${fixed(risk)} USD di 0,01 lot) | reward ${fixed(reward)} | 1:${(reward / risk).toFixed(1)}`,
    );
  }

  if (signal.hit) {
    lines.push(`Catatan: harga sudah menyentuh ${signal.hit} saat sinyal ini terbaca.`);
  }
  lines.push(
    'Sumber: pemantauan chart TradingView, bukan alert webhook.',
    '⚠️ Alert-only. Cek harga broker, spread, dan semua parameter sebelum keputusan apa pun.',
  );
  return lines.join('\n');
}

export function formatProblemNotice(reason: string, failures: number, context: Context): string {
  return [
    `⚠️ **Pemantauan ${displaySymbol(context.symbol)} ${displayTimeframe(context.timeframe)} bermasalah**`,
    `Gagal membaca chart TradingView ${failures} kali berturut-turut: ${reason}`,
    'Sinyal tidak akan terkirim sampai ini pulih.',
  ].join('\n');
}

export function formatRecoveryNotice(context: Context): string {
  return `✅ Pemantauan ${displaySymbol(context.symbol)} ${displayTimeframe(context.timeframe)} pulih dan membaca chart lagi.`;
}
