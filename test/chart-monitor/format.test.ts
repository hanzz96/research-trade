import { describe, expect, it } from 'vitest';
import {
  formatProblemNotice,
  formatRecoveryNotice,
  formatSignalNotice,
} from '../../src/chart-monitor/format.js';
import { extractSignals } from '../../src/chart-monitor/signals.js';
import { BUY_A, BUY_B, drawSignal } from './support.js';

const context = { symbol: 'XAUUSD', timeframe: '30', timeZone: 'Asia/Jakarta' };
const detectedAt = new Date('2026-11-04T09:01:00Z');
const first = (study: Parameters<typeof extractSignals>[0]) => extractSignals(study)[0]!;

describe('formatSignalNotice', () => {
  it('shows direction, levels, risk per oz and the alert-only warning', () => {
    const message = formatSignalNotice(first(BUY_A), detectedAt, context);
    expect(message).toBe(
      [
        '**XAU/USD — BUY CANDIDATE** (M30)',
        'Terdeteksi: 2026-11-04 16:01 (Asia/Jakarta)',
        'Entry 3952.56 | SL 3911.83 | TP 4013.65',
        'Risiko 40.73 USD per oz (sekitar 40.73 USD di 0,01 lot) | reward 61.09 | 1:1.5',
        'Sumber: pemantauan chart TradingView, bukan alert webhook.',
        '⚠️ Alert-only. Cek harga broker, spread, dan semua parameter sebelum keputusan apa pun.',
      ].join('\n'),
    );
  });

  it('mentions a level that price had already touched', () => {
    const message = formatSignalNotice(first(BUY_B), detectedAt, context);
    expect(message).toContain('Catatan: harga sudah menyentuh TP saat sinyal ini terbaca.');
  });

  it('leaves out entry and risk when the entry line is missing', () => {
    const message = formatSignalNotice(
      first(drawSignal({ x: 2, stop: 3900, target: 3990 })),
      detectedAt,
      context,
    );
    expect(message).toContain('SL 3900.00 | TP 3990.00');
    expect(message).not.toContain('Risiko');
    expect(message).not.toContain('Entry');
  });
});

describe('notices about the monitor itself', () => {
  it('explains the failure and that signals are paused', () => {
    const message = formatProblemNotice('the chart timeframe is 15, expected 30', 2, context);
    expect(message).toContain('XAU/USD M30 bermasalah');
    expect(message).toContain('2 kali berturut-turut: the chart timeframe is 15, expected 30');
    expect(message).toContain('Sinyal tidak akan terkirim');
  });

  it('announces recovery', () => {
    expect(formatRecoveryNotice(context)).toContain('XAU/USD M30 pulih');
  });
});
