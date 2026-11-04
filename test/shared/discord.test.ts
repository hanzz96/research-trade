import { describe, expect, it } from 'vitest';
import { DiscordNotifier, NotifyError } from '../../src/shared/discord.js';

describe('DiscordNotifier', () => {
  const url = 'https://discord.com/api/webhooks/123/secret-token';
  const notifier = (fetchImpl: typeof fetch) => new DiscordNotifier(url, fetchImpl);

  it('posts the content with mentions disabled', async () => {
    let captured: RequestInit | undefined;
    await notifier(async (_input, init) => {
      captured = init;
      return new Response(null, { status: 204 });
    }).send('hello @everyone');

    expect(JSON.parse(String(captured?.body))).toEqual({
      content: 'hello @everyone',
      allowed_mentions: { parse: [] },
    });
  });

  it('treats 429 as retryable and honours retry_after', async () => {
    const error = await notifier(
      async () => new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }),
    )
      .send('x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotifyError);
    expect(error).toMatchObject({ retryable: true, retryAfterMs: 1500 });
  });

  it('retries 5xx but not other 4xx', async () => {
    const serverError = await notifier(async () => new Response(null, { status: 503 }))
      .send('x')
      .catch((e: unknown) => e);
    const clientError = await notifier(async () => new Response(null, { status: 404 }))
      .send('x')
      .catch((e: unknown) => e);
    expect(serverError).toMatchObject({ retryable: true });
    expect(clientError).toMatchObject({ retryable: false });
  });

  it('never leaks the webhook URL in error messages', async () => {
    const error = (await notifier(async () => {
      throw new TypeError(`fetch failed for ${url}`);
    })
      .send('x')
      .catch((e: unknown) => e)) as NotifyError;
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('secret-token');
    expect(error.message).not.toContain(url);
  });
});
