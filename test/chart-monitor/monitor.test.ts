import { beforeEach, describe, expect, it } from 'vitest';
import type { ChartSnapshot } from '../../src/chart-monitor/chart-reader.js';
import { checkOnce } from '../../src/chart-monitor/monitor.js';
import {
  BUY_A,
  BUY_B,
  FakeNotifier,
  FakePendingLog,
  MemoryStore,
  SELL_C,
  combine,
  drawSignal,
  monitorConfig,
  silentLog,
  snapshotOf,
} from './support.js';

describe('checkOnce', () => {
  let notifier: FakeNotifier;
  let store: MemoryStore;
  let fallback: FakePendingLog;
  let chart: ChartSnapshot | Error;

  const check = () =>
    checkOnce({
      config: monitorConfig,
      notifier,
      store,
      fallback,
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
    fallback = new FakePendingLog();
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

  describe('when the database refuses a record after the message went out', () => {
    const keyB = 'BUY|3913.52|4009.56';
    const SELL_D = drawSignal({ x: 102, entry: 3940, stop: 3980, target: 3880 });
    const keyD = 'SELL|3980.00|3880.00';

    beforeEach(async () => {
      chart = snapshotOf(combine(SELL_C, BUY_A));
      await check(); // baseline
      chart = snapshotOf(combine(SELL_C, BUY_A, BUY_B));
      store.failRecord = true;
    });

    it('keeps the signal in the fallback file instead of losing track of it', async () => {
      expect(await check()).toEqual({ status: 'ok', newSignals: 1, sent: 1 });

      expect(notifier.sent).toHaveLength(1);
      expect(store.signals.has(keyB)).toBe(false);
      expect(fallback.entries).toHaveLength(1);
      expect(fallback.entries[0]).toMatchObject({
        signal: { key: keyB, direction: 'BUY', entry: 3951.94 },
        announcedAt: '2026-11-04T09:01:00.000Z',
      });
    });

    it('does not announce it again while the database keeps refusing', async () => {
      await check();
      expect(await check()).toEqual({ status: 'ok', newSignals: 0, sent: 0 });
      expect(await check()).toEqual({ status: 'ok', newSignals: 0, sent: 0 });

      expect(notifier.sent).toHaveLength(1);
      expect(fallback.entries).toHaveLength(1);
    });

    it('copies the file into the database at the next check that works, and empties it', async () => {
      await check();
      store.failRecord = false;

      expect(await check()).toEqual({ status: 'ok', newSignals: 0, sent: 0 });
      expect(store.signals.get(keyB)).toBe('announced');
      expect(store.announcedAt.get(keyB)).toEqual(new Date('2026-11-04T09:01:00Z'));
      expect(fallback.entries).toEqual([]);
      expect(notifier.sent).toHaveLength(1);
    });

    it('puts the file entries and the newly caught signals into the database together', async () => {
      await check();
      store.failRecord = false;
      chart = snapshotOf(combine(SELL_C, BUY_A, BUY_B, SELL_D));

      expect(await check()).toEqual({ status: 'ok', newSignals: 1, sent: 1 });

      expect(notifier.sent).toHaveLength(2);
      expect(notifier.sent[1]).toContain('SELL CANDIDATE');
      expect(store.signals.get(keyB)).toBe('announced');
      expect(store.signals.get(keyD)).toBe('announced');
      expect(fallback.entries).toEqual([]);
    });

    it('sends every new signal even though none can be recorded, and keeps them all in the file', async () => {
      chart = snapshotOf(combine(SELL_C, BUY_A, BUY_B, SELL_D));

      expect(await check()).toEqual({ status: 'ok', newSignals: 2, sent: 2 });
      expect(fallback.entries.map((entry) => entry.signal.key)).toEqual([keyB, keyD]);
    });

    it('treats a signal that is only in the file as already announced', async () => {
      await check();
      store.failRecord = false;
      store.signals.delete(keyB); // the database never had it

      // The copy into the database happens first, so it is found there next time as well.
      await check();
      expect(notifier.sent).toHaveLength(1);
    });

    it('warns about damaged lines in the file but carries on', async () => {
      fallback.skipped = 2;
      expect(await check()).toEqual({ status: 'ok', newSignals: 1, sent: 1 });
    });
  });
});
