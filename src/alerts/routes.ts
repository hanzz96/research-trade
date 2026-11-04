import moment from 'moment-timezone';
import type { FastifyInstance } from 'fastify';
import { tokensMatch } from '../shared/auth.js';
import { toIsoString } from '../shared/time.js';
import type { Config } from '../shared/config.js';
import type { RejectionLog } from '../shared/rejections.js';
import { buildIdempotencyKey } from './idempotency.js';
import { signalPayloadSchema } from './payload.js';
import type { SignalProcessor } from './processor.js';
import type { SignalStore } from './store.js';

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export interface AlertRoutesDeps {
  config: Config;
  store: SignalStore;
  processor: SignalProcessor;
  rejections: RejectionLog;
}

/** TradingView webhook: a validated signal is stored first, then sent to Discord in the background. */
export function registerAlertRoutes(
  app: FastifyInstance,
  { config, store, processor, rejections }: AlertRoutesDeps,
): void {
  const allowedIps = new Set(config.ALLOWED_IPS);
  const maxAgeMs = config.MAX_SIGNAL_AGE_MINUTES * 60_000;

  app.post('/webhook/tradingview', async (req, reply) => {
    const reject = async (statusCode: number, reason: string, detail?: string) => {
      req.log.warn({ reason, detail }, 'webhook rejected');
      await rejections
        .record(reason, detail)
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

    const ageMs = moment().diff(moment.utc(payload.timestamp));
    if (ageMs > maxAgeMs) return reject(400, 'stale_signal', payload.timestamp);
    if (ageMs < -MAX_FUTURE_SKEW_MS) return reject(400, 'timestamp_in_future', payload.timestamp);

    let result: { id: number; duplicate: boolean };
    try {
      result = await store.insert({
        idempotencyKey: buildIdempotencyKey(payload),
        symbol: payload.symbol.toUpperCase(),
        timeframe: payload.timeframe,
        direction: payload.direction,
        candleTimestamp: toIsoString(payload.timestamp),
        snapshot: {
          price: payload.price,
          indicators: payload.indicators,
          levels: payload.levels,
          htf: payload.htf,
          ...(payload.plan && { plan: payload.plan }),
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
}
