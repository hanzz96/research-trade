import { NotifyError, type Notifier } from './discord.js';
import { formatSignalMessage } from './format.js';
import type { SignalStore } from './store.js';

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ProcessorOptions {
  store: SignalStore;
  notifier: Notifier;
  log: Logger;
  displayTimezone: string;
  maxAttempts: number;
  backoffMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_BACKOFF_MS = 30_000;

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Sends stored signals to Discord one at a time. The webhook handler only enqueues an id
 * after the signal is persisted, so a slow Discord call never delays the HTTP response.
 */
export class SignalProcessor {
  private chain: Promise<void> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ProcessorOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  enqueue(id: number): void {
    this.chain = this.chain
      .then(() => this.process(id))
      .catch((err) => this.options.log.error({ id, err: errorMessage(err) }, 'signal processing crashed'));
  }

  /** Resolves when everything enqueued so far has finished (used by tests and graceful shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Re-queues anything left unfinished by a previous run. */
  async recover(): Promise<number> {
    const ids = await this.options.store.recoverPending();
    ids.forEach((id) => this.enqueue(id));
    return ids.length;
  }

  private async process(id: number): Promise<void> {
    const { store, notifier, log, displayTimezone, maxAttempts, backoffMs } = this.options;
    if (!(await store.claim(id))) return;

    const signal = await store.get(id);
    if (!signal) return;

    const startedAt = Date.now();
    const content = formatSignalMessage(signal, displayTimezone);
    let attempts = 0;
    let lastError = 'unknown error';

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        await notifier.send(content);
        await store.markSent(id, attempts);
        log.info({ id, attempts, ms: Date.now() - startedAt }, 'signal sent');
        return;
      } catch (err) {
        lastError = errorMessage(err);
        const retryable = err instanceof NotifyError ? err.retryable : true;
        log.warn({ id, attempts, retryable, error: lastError }, 'discord delivery attempt failed');
        if (!retryable || attempts >= maxAttempts) break;
        const retryAfter = err instanceof NotifyError ? err.retryAfterMs : undefined;
        await this.sleep(Math.min(retryAfter ?? backoffMs * 2 ** (attempts - 1), MAX_BACKOFF_MS));
      }
    }

    await store.markFailed(id, attempts, lastError);
    log.error({ id, attempts, error: lastError, ms: Date.now() - startedAt }, 'signal delivery failed');
  }
}
