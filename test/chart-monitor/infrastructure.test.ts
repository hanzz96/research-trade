import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReadExpression, readChart } from '../../src/chart-monitor/chart-reader.js';
import { loadMonitorConfig } from '../../src/chart-monitor/config.js';
import { FileStateStore, emptyState } from '../../src/chart-monitor/state.js';
import { BUY_A } from './support.js';

describe('FileStateStore', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chart-monitor-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('starts empty when there is no file yet', async () => {
    expect(await new FileStateStore(join(directory, 'missing.json')).load()).toEqual(emptyState());
  });

  it('saves and loads what it was given', async () => {
    const store = new FileStateStore(join(directory, 'state.json'));
    const state = { baselined: true, seen: ['BUY|1.00|2.00'], failures: 1, alerted: false };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });

  it('refuses a damaged file instead of silently starting over', async () => {
    const path = join(directory, 'damaged.json');
    await writeFile(path, JSON.stringify({ seen: 'nope' }));
    await expect(new FileStateStore(path).load()).rejects.toThrow('not valid');
  });
});

describe('loadMonitorConfig', () => {
  const webhook = 'https://discord.com/api/webhooks/123/secret-token';

  it('fills in the defaults', () => {
    expect(loadMonitorConfig({ DISCORD_WEBHOOK_URL: webhook })).toMatchObject({
      CDP_HOST: '127.0.0.1',
      CDP_PORT: 9222,
      MONITOR_SYMBOL: 'XAUUSD',
      MONITOR_TIMEFRAME: '30',
      MONITOR_STUDY: 'XAUUSD Entry Reminder',
      MONITOR_DELAY_SECONDS: 60,
      DISPLAY_TIMEZONE: 'Asia/Jakarta',
    });
  });

  it('needs an https Discord webhook', () => {
    expect(() => loadMonitorConfig({})).toThrow('DISCORD_WEBHOOK_URL');
    expect(() => loadMonitorConfig({ DISCORD_WEBHOOK_URL: 'http://example.com/hook' })).toThrow(
      'https://',
    );
  });

  it('only accepts candle lengths that divide the hour', () => {
    expect(loadMonitorConfig({ DISCORD_WEBHOOK_URL: webhook, MONITOR_TIMEFRAME: '15' }).MONITOR_TIMEFRAME).toBe('15');
    expect(() => loadMonitorConfig({ DISCORD_WEBHOOK_URL: webhook, MONITOR_TIMEFRAME: '45' })).toThrow('divide 60');
    expect(() => loadMonitorConfig({ DISCORD_WEBHOOK_URL: webhook, MONITOR_TIMEFRAME: '1D' })).toThrow('minutes');
  });

  it('does not echo the webhook URL in its errors', () => {
    expect(() => loadMonitorConfig({ DISCORD_WEBHOOK_URL: webhook, MONITOR_TIMEFRAME: 'x' })).toThrow(
      /MONITOR_TIMEFRAME/,
    );
    try {
      loadMonitorConfig({ DISCORD_WEBHOOK_URL: webhook, MONITOR_TIMEFRAME: 'x' });
    } catch (err) {
      expect(String(err)).not.toContain('secret-token');
    }
  });
});

describe('chart reader', () => {
  it('passes the study name as a quoted string, so it cannot change the script', () => {
    const expression = buildReadExpression('Evil") ; alert(1); ("');
    expect(expression.endsWith(`(${JSON.stringify('Evil") ; alert(1); ("')})`)).toBe(true);
  });

  it('returns what the page answered when it has the expected shape', async () => {
    const page = { symbol: 'OANDA:XAUUSD', resolution: '30', study: BUY_A };
    expect(await readChart(async () => page, 'XAUUSD Entry Reminder')).toEqual(page);
  });

  it('rejects an answer in a shape it does not know', async () => {
    await expect(readChart(async () => ({ hello: 'world' }), 'x')).rejects.toThrow('unexpected reply');
    await expect(readChart(async () => null, 'x')).rejects.toThrow('unexpected reply');
  });
});
