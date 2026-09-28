import { describe, it, expect } from 'vitest';
import { formatMoney } from '@/lib/ui/money';
import { money } from '@/app/account/format';

describe('formatMoney (money formatting in one place)', () => {
  it.each([[1234.5, 'USD'], [100000, 'INR'], [0, 'MXN'], [12.345, 'USD']])('equals the portal’s money(%s,%s)', (a, c) => {
    expect(formatMoney(a, c)).toBe(money(a, c));
  });
  it('an unknown currency code falls back to "<n> <code>"', () => {
    expect(formatMoney(5, 'ZZZZ')).toBe('5.00 ZZZZ');
  });
  it('rejects non-finite amounts instead of rendering NaN', () => {
    expect(formatMoney(Number.NaN, 'USD')).toBe('—');
    expect(formatMoney(Number.POSITIVE_INFINITY, 'USD')).toBe('—');
  });
});

describe('formatMoney edge values', () => {
  it('negative zero renders as plain zero', () => {
    expect(formatMoney(-0, 'USD')).toBe('$0.00');
    expect(formatMoney(-0.001, 'USD')).toBe('$0.00');
  });
  it('negatives keep their sign', () => {
    expect(formatMoney(-5, 'USD')).toBe('-$5.00');
  });
  it('zero-decimal currencies have no minor units', () => {
    expect(formatMoney(1234, 'JPY')).toBe('¥1,234');
  });
});
