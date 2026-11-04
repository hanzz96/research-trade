import { describe, expect, it } from 'vitest';
import { displaySymbol, displayTimeframe } from '../../src/shared/display.js';

describe('display helpers', () => {
  it.each([
    ['15', 'M15'],
    ['60', 'H1'],
    ['240', 'H4'],
    ['1D', 'D1'],
    ['D', 'D1'],
    ['1W', 'W1'],
    ['1M', 'MN1'],
  ])('displays timeframe %s as %s', (input, expected) => {
    expect(displayTimeframe(input)).toBe(expected);
  });

  it('displays currency pairs with a slash and leaves other symbols alone', () => {
    expect(displaySymbol('XAUUSD')).toBe('XAU/USD');
    expect(displaySymbol('BTCUSDT')).toBe('BTCUSDT');
  });
});
