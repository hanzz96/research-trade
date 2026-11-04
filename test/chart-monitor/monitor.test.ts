import { beforeEach, describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '../../src/chart-monitor/chart-reader.js';
import { checkOnce } from '../../src/chart-monitor/monitor.js';
import {
  BUY_A,
  BUY_B,
  FakeNotifier,
  MemoryStore,
  SELL_C,
  combine,
  monitorConfig,
  silentLog,
  snapshotOf,
} from './support.js';

describe('checkOnce', () => {
  let notifier: FakeNotifier;
  let store: MemoryStore;
  let chart: ChartSnapshot | Error;

  const check = () =>
    checkOnce({
      config: monitorConfig,
      notifier,
      store,
      log: silentLog,
      now: () => new Date('2026-11-04T09:01:00Z'),
      readChart: async () => {
        if (chart instanceof Error) throw chart;
        return chart;
      },
    });

  beforeEach(() => {
    notifier = new FakeNotifier();
    store = new MemoryStore();
    chart = snapshotOf(combine(SELL_C, BUY_A));
  });

  describe('signals', () => {
    it('only records what is already on the chart the first time', async () => {
      expect(await check()).toEqual({ status: 'baseline', signals: 2 });
      expect(notifier.sent).toEqual([]);
      expect(store.health.baselined).toBe(true);
      expect([...store.signals]).toEqual([
        ['SELL|3961.68|3858.98', 'baseline'],
        ['BUY|3911.83|4013.65', 'baseline'],
      ]);
    });

    it('announces a new signal once and not again on the next check', async () => {
      await check();
      chart = snapshotOf(combine(SELL_C, BUY_A, BUY_B));

      expect(await check()).toEqual({ status: 'ok', newSignals: 1, sent: 1 });
      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0]).toContain('XAU/USD — BUY CANDIDATE** (M30)');
      expect(notifier.sent[0]).toContain('Entry 3951.94 | SL 3913.52 | TP 4009.56');
      expect(notifier.sent[0]).toContain('2026-11-04 16:01 (Asia/Jakarta)');

      expect(await check()).toEqual({ status: 'ok', newSignals: 0, sent: 0 });
      expect(notifier.sent).toHaveLength(1);
    });

    it('sends several new signals oldest first', async () => {
      chart = snapshotOf(combine(BUY_A));
      await check();
      chart = snapshotOf(combine(BUY_A, SELL_C, BUY_B));

      await check();
      expect(notifier.sent.map((message) => message.includes('SELL') ? 'SELL' : 'BUY')).toEqual(['SELL', 'BUY']);
    });

    it('does not remember a signal whose Discord message failed, and retries it next time', async () => {
      await check();
      chart = snapshotOf(combine(SELL_C, BUY_A, BUY_B));
      notifier.failNext = 1;

      expect(await check()).toEqual({ status: 'failed', reason: 'Discord: discord responded with HTTP 503' });
      expect(notifier.sent).toEqual([]);

      expect(await check()).toEqual({ status: 'ok', newSignals: 1, sent: 1 });
      expect(notifier.sent).toHaveLength(1);
    });

    it('keeps the signals it did send when a later one fails', async () => {
      chart = snapshotOf(combine(BUY_A));
      await check();
      chart = snapshotOf(combine(BUY_A, SELL_C, BUY_B));
      // First send works, second fails.
      const originalSend = notifier.send.bind(notifier);
      let calls = 0;
      notifier.send = async (content) => {
        calls += 1;
        if (calls === 2) throw new Error('discord responded with HTTP 503');
        return originalSend(content);
      };

      expect(await check()).toMatchObject({ status: 'failed' });
      expect(notifier.sent).toHaveLength(1);
      expect(store.signals.get('SELL|3961.68|3858.98')).toBe('announced');
      expect(store.signals.has('BUY|3913.52|4009.56')).toBe(false);
    });
  });

  describe('when the chart cannot be read', () => {
    it.each([
      ['another symbol', snapshotOf(combine(BUY_A), { symbol: 'OANDA:EURUSD' }), 'expected XAUUSD'],
      ['another timeframe', snapshotOf(combine(BUY_A), { resolution: '15' }), 'timeframe is 15'],
      ['no indicator', snapshotOf(null), 'is not on the chart'],
      ['a page error', snapshotOf(null, { error: 'boom' }), 'reported an error: boom'],
    ])('fails for %s without changing what it remembers', async (_name, snapshot, reason) => {
      await check();
      const before = [...store.signals];
      chart = snapshot;

      const result = await check();
      expect(result).toMatchObject({ status: 'failed' });
      expect(result.status === 'failed' && result.reason).toContain(reason);
      expect([...store.signals]).toEqual(before);
      expect(notifier.sent).toEqual([]);
    });

    it('treats a thrown read error as a failed check', async () => {
      chart = new Error('TradingView is not reachable on 127.0.0.1:9222.');
      expect(await check()).toEqual({
        status: 'failed',
        reason: 'TradingView is not reachable on 127.0.0.1:9222.',
      });
    });

    it('sends one problem notice after two failures, then one recovery notice', async () => {
      await check();
      chart = new Error('TradingView is not reachable on 127.0.0.1:9222.');

      await check();
      expect(notifier.sent).toEqual([]);
      await check();
      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0]).toContain('bermasalah');
      expect(notifier.sent[0]).toContain('2 kali berturut-turut');
      expect(notifier.sent[0]).toContain('127.0.0.1:9222');

      await check();
      expect(notifier.sent).toHaveLength(1); // not repeated

      chart = snapshotOf(combine(SELL_C, BUY_A));
      expect(await check()).toEqual({ status: 'ok', newSignals: 0, sent: 0 });
      expect(notifier.sent).toHaveLength(2);
      expect(notifier.sent[1]).toContain('pulih');
      expect(store.health).toMatchObject({ failures: 0, alerted: false });
    });

    it('does not announce the chart as new signals if the very first reads failed', async () => {
      chart = new Error('no TradingView chart tab is open');
      await check();
      expect(store.health.baselined).toBe(false);

      chart = snapshotOf(combine(SELL_C, BUY_A));
      expect(await check()).toEqual({ status: 'baseline', signals: 2 });
      expect(notifier.sent).toEqual([]);
    });
  });
});
