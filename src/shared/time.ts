import moment from 'moment-timezone';

/**
 * UTC ISO string with milliseconds and a trailing Z, e.g. "2026-11-04T09:01:00.000Z".
 * Unlike moment on its own, which returns null for a bad value, this throws, the way
 * `Date#toISOString` does: a bad date should stop the code, not end up in a key or a message.
 */
export function toIsoString(value: moment.MomentInput): string {
  const parsed = moment.utc(value);
  if (!parsed.isValid()) throw new RangeError(`not a valid date: ${String(value)}`);
  return parsed.toISOString();
}
