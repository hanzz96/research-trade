import type { FastifyInstance } from 'fastify';
import type { FetchLike } from '../../src/webhook-cli/client.js';

/** A fetch that talks to the in-process server, so the CLI is tested against the real routes. */
export const fetchThrough =
  (app: FastifyInstance): FetchLike =>
  (async (input: string, init?: RequestInit) => {
    const response = await app.inject({
      method: init?.method as 'GET' | 'POST',
      url: new URL(input).pathname,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string | undefined,
    });
    return new Response(response.body, { status: response.statusCode });
  }) as unknown as FetchLike;
