import type { FastifyInstance } from 'fastify';
import { tokensMatch } from '../shared/auth.js';
import type { Config } from '../shared/config.js';
import type { RejectionLog } from '../shared/rejections.js';
import { findBarTimeProblem, ingestSchema, type BarStore } from './bars.js';

export interface ForwardTestRoutesDeps {
  config: Config;
  barStore: BarStore;
  rejections: RejectionLog;
}

/**
 * Closed candles pushed by the MT5 Expert Advisor or a backfill script, up to 500 per call.
 * The route only exists when INGEST_TOKEN is configured.
 */
export function registerForwardTestRoutes(
  app: FastifyInstance,
  { config, barStore, rejections }: ForwardTestRoutesDeps,
): void {
  const ingestToken = config.INGEST_TOKEN;
  if (!ingestToken) return;
  const allowedTimeframes = new Set(config.BAR_TIMEFRAMES);

  app.post('/ingest/bars', { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const reject = async (statusCode: number, reason: string, detail?: string) => {
      req.log.warn({ reason, detail }, 'ingest rejected');
      await rejections
        .record(`ingest_${reason}`, detail)
        .catch((err) => req.log.error({ err }, 'could not record rejection'));
      return reply.code(statusCode).send({ status: 'rejected', reason });
    };

    const header = req.headers['x-ingest-token'];
    if (typeof header !== 'string' || !tokensMatch(header, ingestToken)) {
      return reject(401, 'unauthorized');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(typeof req.body === 'string' ? req.body : '');
    } catch {
      return reject(400, 'invalid_json');
    }

    const parsed = ingestSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return reject(400, 'invalid_payload', issues);
    }
    const batch = parsed.data;

    if (!config.ALLOWED_SYMBOLS.includes(batch.symbol.toUpperCase())) {
      return reject(400, 'unsupported_symbol', batch.symbol);
    }
    if (!allowedTimeframes.has(batch.timeframe)) {
      return reject(400, 'unsupported_timeframe', batch.timeframe);
    }
    const timeProblem = findBarTimeProblem(batch);
    if (timeProblem) return reject(400, 'invalid_bar_time', timeProblem);

    try {
      const { inserted } = await barStore.insertMany(batch);
      return {
        status: 'ok',
        received: batch.bars.length,
        inserted,
        duplicates: batch.bars.length - inserted,
      };
    } catch (err) {
      req.log.error({ err }, 'could not persist bars');
      return reply.code(503).send({ status: 'error', reason: 'storage_unavailable' });
    }
  });
}
