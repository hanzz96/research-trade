import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { SignalProcessor } from './alerts/processor.js';
import { registerAlertRoutes } from './alerts/routes.js';
import type { SignalStore } from './alerts/store.js';
import type { BarStore } from './forward-test/bars.js';
import { registerForwardTestRoutes } from './forward-test/routes.js';
import type { Config } from './shared/config.js';
import type { RejectionLog } from './shared/rejections.js';

export interface ServerDeps {
  config: Config;
  store: SignalStore;
  processor: SignalProcessor;
  rejections: RejectionLog;
  /** Enables POST /ingest/bars when provided together with INGEST_TOKEN. */
  barStore?: BarStore;
  /** Shared with the processor so request and delivery logs use one logger. Omit to disable logging. */
  logger?: Logger;
}

/** Builds the HTTP app: common plumbing here, endpoints registered by each feature. */
export async function buildServer({
  config,
  store,
  processor,
  rejections,
  barStore,
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
  // body as a raw string and let each route parse it to record clean rejection reasons.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get('/health', async (_req, reply) => {
    try {
      return {
        status: 'ok',
        signals: await store.stats(),
        ...(barStore ? { bars: await barStore.latestByTimeframe() } : {}),
      };
    } catch (err) {
      app.log.error({ err }, 'health check failed');
      return reply.code(503).send({ status: 'degraded' });
    }
  });

  registerAlertRoutes(app, { config, store, processor, rejections });
  if (barStore) registerForwardTestRoutes(app, { config, barStore, rejections });

  return app;
}
