import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/webhook-cli/program.js';
import type { FetchLike } from '../../src/webhook-cli/client.js';
import { createHarness, TOKEN } from '../support/helpers.js';
import { fetchThrough } from './support.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;

const INGEST_TOKEN = 'ingest-token-0123456789abcdef';
const DISCORD_URL = 'https://discord.com/api/webhooks/123/very-secret-discord-token';
const ENV = { WEBHOOK_TOKEN: TOKEN, INGEST_TOKEN, DISCORD_WEBHOOK_URL: DISCORD_URL };

/** Runs the CLI with captured output; `failed` says whether the exit code would be 1. */
async function runCli(args: string[], fetchImpl: FetchLike, env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  let failed = false;
  const program = buildProgram({
    env,
    fetch: fetchImpl,
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    fail: () => {
      failed = true;
    },
    commanderOutput: { writeOut: (text) => out.push(text), writeErr: (text) => err.push(text) },
  });
  let thrown: { code?: string; message: string } | undefined;
  try {
    await program.parseAsync(['node', 'webhook', ...args]);
  } catch (error) {
    thrown = error as { code?: string; message: string };
  }
  const text = [...out, ...err].join('\n');
  return { out: out.join('\n'), err: err.join('\n'), text, failed, thrown };
}

const neverCalled: FetchLike = (async () => {
  throw new Error('no request expected');
}) as unknown as FetchLike;

describe('webhook CLI program', () => {
  describe('secrets', () => {
    it.each(['signal', 'bars', 'discord', 'health'])('never shows a token or the Discord URL in %s --help', async (command) => {
      const { text, thrown } = await runCli([command, '--help'], neverCalled);
      expect(thrown?.code).toBe('commander.helpDisplayed');
      for (const secret of [TOKEN, INGEST_TOKEN, DISCORD_URL, 'very-secret-discord-token']) {
        expect(text).not.toContain(secret);
      }
    });

    it('does not print the token it sent, even when the server refuses it', async () => {
      const h = await createHarness();
      try {
        const t = await h.build();
        const { text, failed } = await runCli(['signal', '--token', 'wrong-token-0123456789abcd'], fetchThrough(t.app));
        expect(failed).toBe(true);
        expect(text).toContain('HTTP 401');
        expect(text).toContain('hint: the token does not match');
        expect(text).not.toContain('wrong-token-0123456789abcd');
        expect(text).not.toContain(TOKEN);
      } finally {
        await h.close();
      }
    });
  });

  describe('options', () => {
    it.each([
      [['signal', '--direction', 'HOLD'], 'Allowed choices are BUY, SELL'],
      [['signal', '--price', '5'], 'at least 100'],
      [['signal', '--age-minutes', '-1'], 'whole number'],
      [['signal', '--url', 'not a url'], 'http(s) URL'],
      [['signal', '--url', 'ftp://example.com'], 'http(s) URL'],
      [['bars', '--timeframe', '45'], 'divides 60'],
      [['bars', '--count', '0'], 'from 1 to 500'],
      [['bars', '--count', '501'], 'from 1 to 500'],
      [['health', '--url', 'nope'], 'http(s) URL'],
    ])('refuses %j', async (args, message) => {
      const { err, thrown } = await runCli(args, neverCalled);
      expect(thrown?.code).toBe('commander.invalidArgument');
      expect(err).toContain(message);
    });

    it('needs the token to be set', async () => {
      const { err, failed } = await runCli(['signal'], neverCalled, {});
      expect(failed).toBe(true);
      expect(err).toContain('WEBHOOK_TOKEN is not set');
      const bars = await runCli(['bars'], neverCalled, {});
      expect(bars.err).toContain('INGEST_TOKEN is not set');
      const discord = await runCli(['discord'], neverCalled, {});
      expect(discord.err).toContain('DISCORD_WEBHOOK_URL is not set');
    });
  });

  describe('when the server cannot be reached', () => {
    const refused: FetchLike = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchLike;

    it('says so, with the address from HOST and PORT, and fails', async () => {
      const { err, failed } = await runCli(['signal'], refused, { ...ENV, HOST: '0.0.0.0', PORT: '3100' });
      expect(failed).toBe(true);
      expect(err).toBe('could not reach http://127.0.0.1:3100: is the server running (npm run dev)?');
    });

    it('does not echo credentials typed into the URL', async () => {
      const { err } = await runCli(['health', '--url', 'http://user:hunter2@example.com:3000/path'], refused);
      expect(err).toContain('http://example.com:3000');
      expect(err).not.toContain('hunter2');
    });

    it('does not call every TypeError a connection problem', async () => {
      const broken: FetchLike = (async () => {
        throw new TypeError('something else entirely');
      }) as unknown as FetchLike;
      const { err } = await runCli(['health'], broken);
      expect(err).toBe('something else entirely');
    });
  });

  describe('against the real server', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h.close();
    });
    beforeEach(async () => {
      await h.reset();
    });

    it('sends a signal that is accepted and reaches Discord', async () => {
      const t = await h.build();
      const { out, failed } = await runCli(['signal', '--direction', 'SELL'], fetchThrough(t.app));

      expect(failed).toBe(false);
      expect(out).toContain('HTTP 200 {"status":"accepted"');
      expect(out).toContain('A Discord message should follow');
      await t.processor.idle();
      expect(h.notifier.sent[0]).toContain('SELL CANDIDATE');
    });

    it('shows the duplicate answer with --twice', async () => {
      const t = await h.build();
      const { out } = await runCli(['signal', '--twice'], fetchThrough(t.app));

      expect(out).toContain('#1 HTTP 200 {"status":"accepted"');
      expect(out).toContain('#2 HTTP 200 {"status":"duplicate"');
    });

    it('explains a 400 and fails', async () => {
      const t = await h.build();
      const { out, failed } = await runCli(['signal', '--age-minutes', '300'], fetchThrough(t.app));

      expect(failed).toBe(true);
      expect(out).toContain('stale_signal');
      expect(out).toContain('hint: the server rejected the request');
    });

    it('sends candles and warns that they are synthetic', async () => {
      const t = await h.build({ INGEST_TOKEN });
      const { out, failed } = await runCli(['bars', '--count', '2'], fetchThrough(t.app));

      expect(failed).toBe(false);
      expect(out).toContain('"inserted":2');
      expect(out).toContain('synthetic');
      expect(out).toContain("DELETE FROM bars WHERE source = 'webhook-cli'");
    });

    it('does not print the synthetic-data warning when the candles were refused', async () => {
      const t = await h.build(); // no INGEST_TOKEN: the route does not exist
      const { out, failed } = await runCli(['bars'], fetchThrough(t.app));

      expect(failed).toBe(true);
      expect(out).toContain('HTTP 404');
      expect(out).not.toContain('synthetic');
    });

    it('reads the health of the server', async () => {
      const t = await h.build();
      const { out, failed } = await runCli(['health'], fetchThrough(t.app));
      expect(failed).toBe(false);
      expect(out).toContain('HTTP 200 {"status":"ok"');
    });
  });

  describe('discord', () => {
    it('posts the message and says Discord accepted it, without printing the URL', async () => {
      const seen: Array<{ url: string; body: string }> = [];
      const accept: FetchLike = (async (url: string, init?: RequestInit) => {
        seen.push({ url, body: String(init?.body) });
        return new Response(null, { status: 204 });
      }) as unknown as FetchLike;

      const { out, text, failed } = await runCli(['discord', '--message', 'halo'], accept);
      expect(failed).toBe(false);
      expect(out).toBe('Discord accepted the message.');
      expect(text).not.toContain('very-secret-discord-token');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe(DISCORD_URL);
      expect(JSON.parse(seen[0]!.body)).toEqual({ content: 'halo', allowed_mentions: { parse: [] } });
    });

    it('reports a refusal without leaking the URL', async () => {
      const refuse: FetchLike = (async () => new Response(null, { status: 404 })) as unknown as FetchLike;
      const { err, failed } = await runCli(['discord'], refuse);
      expect(failed).toBe(true);
      expect(err).toContain('HTTP 404');
      expect(err).not.toContain('very-secret-discord-token');
    });
  });
});
