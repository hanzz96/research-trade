import { describe, expect, it } from 'vitest';
import { formatTime } from '../../src/shared/display.js';
import { toIsoString } from '../../src/shared/time.js';

describe('toIsoString', () => {
  it('gives UTC with milliseconds and a Z, for strings, dates and numbers alike', () => {
    expect(toIsoString('2026-11-04T09:01:00Z')).toBe('2026-11-04T09:01:00.000Z');
    expect(toIsoString('2026-11-04T16:01:00+07:00')).toBe('2026-11-04T09:01:00.000Z');
    expect(toIsoString(new Date('2026-11-04T09:01:00.123Z'))).toBe('2026-11-04T09:01:00.123Z');
    expect(toIsoString(Date.UTC(2026, 10, 4, 9, 1))).toBe('2026-11-04T09:01:00.000Z');
  });

  it('matches Date#toISOString for ISO input', () => {
    const input = '2026-02-28T23:59:59.999Z';
    expect(toIsoString(input)).toBe(new Date(input).toISOString());
  });

  it('throws for something that is not a date, instead of returning null', () => {
    expect(() => toIsoString('')).toThrow(RangeError);
    expect(() => toIsoString('2026-13-45T00:00:00Z')).toThrow('not a valid date');
    expect(() => toIsoString(new Date('nope'))).toThrow(RangeError);
  });
});

describe('formatTime', () => {
  it('shows local time in the given zone, with midnight as 00:00', () => {
    expect(formatTime('2026-11-04T09:01:00Z', 'Asia/Jakarta')).toBe('2026-11-04 16:01');
    expect(formatTime('2026-11-04T17:00:00Z', 'Asia/Jakarta')).toBe('2026-11-05 00:00');
    expect(formatTime(new Date('2026-11-04T09:01:00Z'), 'UTC')).toBe('2026-11-04 09:01');
  });

  it('throws for something that is not a date, instead of printing "Invalid date"', () => {
    expect(() => formatTime('not a date', 'Asia/Jakarta')).toThrow(RangeError);
  });
});
