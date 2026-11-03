import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
  WEBHOOK_TOKEN: 'a-long-enough-token-1234',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 3000,
      ALLOWED_SYMBOLS: ['XAUUSD'],
      ALLOWED_TIMEFRAMES: ['15'],
      ALLOWED_IPS: [],
      DISPLAY_TIMEZONE: 'Asia/Jakarta',
    });
    expect(config.DISCORD_WEBHOOK_URL).toBeUndefined();
  });

  it('fails fast and names every problem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*WEBHOOK_TOKEN/);
  });

  it('rejects a short token and a non-postgres URL', () => {
    expect(() => loadConfig({ ...baseEnv, WEBHOOK_TOKEN: 'short' })).toThrow(/WEBHOOK_TOKEN/);
    expect(() => loadConfig({ ...baseEnv, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('parses comma lists and upper-cases symbols', () => {
    const config = loadConfig({
      ...baseEnv,
      ALLOWED_SYMBOLS: 'xauusd, eurusd',
      ALLOWED_IPS: '1.1.1.1,2.2.2.2',
    });
    expect(config.ALLOWED_SYMBOLS).toEqual(['XAUUSD', 'EURUSD']);
    expect(config.ALLOWED_IPS).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('treats an empty DISCORD_WEBHOOK_URL as unset and requires https otherwise', () => {
    expect(loadConfig({ ...baseEnv, DISCORD_WEBHOOK_URL: '' }).DISCORD_WEBHOOK_URL).toBeUndefined();
    expect(() => loadConfig({ ...baseEnv, DISCORD_WEBHOOK_URL: 'http://discord.com/x' })).toThrow(
      /DISCORD_WEBHOOK_URL/,
    );
  });

  it('rejects an unknown time zone', () => {
    expect(() => loadConfig({ ...baseEnv, DISPLAY_TIMEZONE: 'Mars/Base' })).toThrow(
      /DISPLAY_TIMEZONE/,
    );
  });
});
