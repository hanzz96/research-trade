import type moment from 'moment-timezone';
import {
  buildBarsPayload,
  buildSignalPayload,
  type BarsOptions,
  type SignalOptions,
} from './payloads.js';

export type FetchLike = typeof fetch;

export interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

const TIMEOUT_MS = 10_000;

async function request(
  fetchImpl: FetchLike,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetchImpl(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

const join = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, '')}${path}`;

export interface SendSignalOptions extends SignalOptions {
  baseUrl: string;
  /** Send the same body a second time: the server should answer "duplicate". */
  twice: boolean;
}

export async function sendSignal(
  options: SendSignalOptions,
  fetchImpl: FetchLike = fetch,
  now?: moment.MomentInput,
): Promise<HttpResult[]> {
  const payload = buildSignalPayload(options, now);
  const url = join(options.baseUrl, '/webhook/tradingview');
  const results = [await request(fetchImpl, 'POST', url, payload)];
  if (options.twice) results.push(await request(fetchImpl, 'POST', url, payload));
  return results;
}

export interface SendBarsOptions extends BarsOptions {
  baseUrl: string;
  token: string;
}

export function sendBars(
  options: SendBarsOptions,
  fetchImpl: FetchLike = fetch,
  now?: moment.MomentInput,
): Promise<HttpResult> {
  return request(fetchImpl, 'POST', join(options.baseUrl, '/ingest/bars'), buildBarsPayload(options, now), {
    'x-ingest-token': options.token,
  });
}

export function checkHealth(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<HttpResult> {
  return request(fetchImpl, 'GET', join(baseUrl, '/health'));
}
