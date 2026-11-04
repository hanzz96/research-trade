import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of a received secret against the expected one. */
export function tokensMatch(received: string, expected: string): boolean {
  // Hash both sides so the comparison takes the same time whatever the lengths are.
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
