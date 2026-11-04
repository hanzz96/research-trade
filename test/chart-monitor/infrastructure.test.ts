import { describe, expect, it } from 'vitest';
import { buildReadExpression, readChart } from '../../src/chart-monitor/chart-reader.js';
import { loadMonitorConfig } from '../../src/chart-monitor/config.js';
import { BUY_A } from './support.js';

describe('loadMonitorConfig', () => {
  const webhook = 'https://discord.com/api/webhooks/123/secret-token';
  const database = 'postgres://user:pass@localhost:5432/trade_view';
  const base = { DISCORD_WEBHOOK_URL: webhook, DATABASE_URL: database };

  it('fills in the defaults', () => {
    expect(loadMonitorConfig(base)).toMatchObject({
      CDP_HOST: '127.0.0.1',
      CDP_PORT: 9222,
      MONITOR_SYMBOL: 'XAUUSD',
      MONITOR_TIMEFRAME: '30',
      MONITOR_STUDY: 'XAUUSD Entry Reminder',
      MONITOR_FALLBACK_FILE: '.monitor-pending.jsonl',
      MONITOR_DELAY_SECONDS: 60,
      DISPLAY_TIMEZONE: 'Asia/Jakarta',
    });
  });

  it('needs an https Discord webhook and a Postgres URL', () => {
    expect(() => loadMonitorConfig({ DATABASE_URL: database })).toThrow('DISCORD_WEBHOOK_URL');
    expect(() => loadMonitorConfig({ ...base, DISCORD_WEBHOOK_URL: 'http://example.com/hook' })).toThrow(
      'https://',
    );
    expect(() => loadMonitorConfig({ DISCORD_WEBHOOK_URL: webhook })).toThrow('DATABASE_URL');
    expect(() => loadMonitorConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow('postgres://');
  });

  it('only accepts candle lengths that divide the hour', () => {
    expect(loadMonitorConfig({ ...base, MONITOR_TIMEFRAME: '15' }).MONITOR_TIMEFRAME).toBe('15');
    expect(() => loadMonitorConfig({ ...base, MONITOR_TIMEFRAME: '45' })).toThrow('divide 60');
    expect(() => loadMonitorConfig({ ...base, MONITOR_TIMEFRAME: '1D' })).toThrow('minutes');
  });

  it('does not echo the webhook URL in its errors', () => {
    expect(() => loadMonitorConfig({ ...base, MONITOR_TIMEFRAME: 'x' })).toThrow(
      /MONITOR_TIMEFRAME/,
    );
    try {
      loadMonitorConfig({ ...base, MONITOR_TIMEFRAME: 'x' });
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
