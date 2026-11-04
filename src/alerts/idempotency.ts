import { toIsoString } from '../shared/time.js';

export interface IdempotencyInput {
  symbol: string;
  timeframe: string;
  timestamp: string;
  direction: string;
}

/**
 * Stable key built by the backend from symbol + timeframe + candle time + direction.
 * Any event id sent by the client is ignored on purpose.
 */
export function buildIdempotencyKey(input: IdempotencyInput): string {
  return [
    input.symbol.toUpperCase(),
    input.timeframe,
    toIsoString(input.timestamp),
    input.direction,
  ].join('|');
}
