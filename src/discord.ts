export interface Notifier {
  send(content: string): Promise<void>;
}

export class NotifyError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}

/** Used when DISCORD_WEBHOOK_URL is not configured: signals are stored, delivery is marked FAILED. */
export class DisabledNotifier implements Notifier {
  async send(): Promise<void> {
    throw new NotifyError('DISCORD_WEBHOOK_URL is not configured', false);
  }
}

export class DiscordNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(content: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No mentions: an alert must never ping @everyone.
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Never include the error message verbatim: it can contain the webhook URL.
      const name = err instanceof Error ? err.name : 'unknown';
      throw new NotifyError(`discord request failed (${name})`, true);
    }

    if (response.ok) return;

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
      const retryAfterMs =
        typeof body.retry_after === 'number' ? Math.ceil(body.retry_after * 1000) : undefined;
      throw new NotifyError('discord rate limited', true, retryAfterMs);
    }
    throw new NotifyError(`discord responded with HTTP ${response.status}`, response.status >= 500);
  }
}
