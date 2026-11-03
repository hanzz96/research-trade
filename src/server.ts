import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { buildIdempotencyKey } from './idempotency.js';
import { signalPayloadSchema } from './payload.js';
import type { SignalProcessor } from './processor.js';
import type { SignalStore } from './store.js';

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function tokensMatch(received: string, expected: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface ServerDeps {
  config: Config;
  store: SignalStore;
  processor: SignalProcessor;
  /** Shared with the processor so request and delivery logs use one logger. Omit to disable logging. */
  logger?: Logger;
}

export async function buildServer({
  config,
  store,
  processor,
  logger,
}: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger as FastifyBaseLogger } : {}),
    // Trust only the N nearest hops (the tunnel), so a client cannot spoof its IP via X-Forwarded-For.
    trustProxy: config.TRUST_PROXY_HOPS > 0 ? (_address, hop) => hop < config.TRUST_PROXY_HOPS : false,
    bodyLimit: 16 * 1024,
  });

  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });

  // TradingView sends text/plain when the alert message is not valid JSON, so take every
  // body as a raw string and parse it ourselves to record clean rejection reasons.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const allowedIps = new Set(config.ALLOWED_IPS);
  const maxAgeMs = config.MAX_SIGNAL_AGE_MINUTES * 60_000;

  app.get('/health', async (_req, reply) => {
    try {
      return { status: 'ok', signals: await store.stats() };
    } catch (err) {
      app.log.error({ err }, 'health check failed');
      return reply.code(503).send({ status: 'degraded' });
    }
  });

  app.post('/webhook/tradingview', async (req, reply) => {
    const reject = async (statusCode: number, reason: string, detail?: string) => {
      req.log.warn({ reason, detail }, 'webhook rejected');
      await store
        .recordRejection(reason, detail)
        .catch((err) => req.log.error({ err }, 'could not record rejection'));
      return reply.code(statusCode).send({ status: 'rejected', reason });
    };

    if (allowedIps.size > 0 && !allowedIps.has(req.ip)) {
      return reject(403, 'ip_not_allowed');
    }

    const body = typeof req.body === 'string' ? req.body : '';
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return reject(400, 'invalid_json');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return reject(400, 'invalid_json', 'body must be a JSON object');
    }

    const { token, ...rest } = raw as Record<string, unknown>;
    if (typeof token !== 'string' || !tokensMatch(token, config.WEBHOOK_TOKEN)) {
      return reject(401, 'unauthorized');
    }

    const parsed = signalPayloadSchema.safeParse(rest);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return reject(400, 'invalid_payload', issues);
    }
    const payload = parsed.data;

    if (!config.ALLOWED_SYMBOLS.includes(payload.symbol.toUpperCase())) {
      return reject(400, 'unsupported_symbol', payload.symbol);
    }
    if (!config.ALLOWED_TIMEFRAMES.includes(payload.timeframe)) {
      return reject(400, 'unsupported_timeframe', payload.timeframe);
    }

    const ageMs = Date.now() - Date.parse(payload.timestamp);
    if (ageMs > maxAgeMs) return reject(400, 'stale_signal', payload.timestamp);
    if (ageMs < -MAX_FUTURE_SKEW_MS) return reject(400, 'timestamp_in_future', payload.timestamp);

    let result: { id: number; duplicate: boolean };
    try {
      result = await store.insert({
        idempotencyKey: buildIdempotencyKey(payload),
        symbol: payload.symbol.toUpperCase(),
        timeframe: payload.timeframe,
        direction: payload.direction,
        candleTimestamp: new Date(payload.timestamp).toISOString(),
        snapshot: {
          price: payload.price,
          indicators: payload.indicators,
          levels: payload.levels,
          htf: payload.htf,
        },
      });
    } catch (err) {
      req.log.error({ err }, 'could not persist signal');
      return reply.code(503).send({ status: 'error', reason: 'storage_unavailable' });
    }

    if (result.duplicate) {
      req.log.info({ id: result.id }, 'duplicate signal ignored');
      return { status: 'duplicate', id: result.id };
    }

    // Respond first; Discord delivery happens in the background.
    processor.enqueue(result.id);
    return { status: 'accepted', id: result.id };
  });

  return app;
}
