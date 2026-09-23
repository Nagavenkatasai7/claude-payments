/**
 * Program-Fix 7 — the ONE dollars→minor-units conversion shared by the Stripe
 * PaymentIntent create (amount) and the webhook cross-check (amount_received).
 * Stripe amounts are integers in the smallest currency unit
 * (https://docs.stripe.com/api/payment_intents/create.md, `amount`). Float
 * multiplication is wrong for values like 0.29 * 100 = 28.999…, so the helper
 * must round from the 2-decimal ledger value, never truncate.
 */
import { describe, it, expect } from 'vitest';
import { toMinorUnits, STRIPE_MIN_USD_CENTS } from '@/lib/funding-amount';

describe('toMinorUnits', () => {
  it.each([
    [19.99, 1999],
    [0.29, 29],
    [1234.35, 123435],
    [200, 20000],
    [0.5, 50],
    [4.35, 435],
    [999999.99, 99999999],
  ])('%s → %s cents', (usd, cents) => {
    expect(toMinorUnits(usd)).toBe(cents);
  });

  it('refuses a non-finite, negative or zero amount', () => {
    expect(() => toMinorUnits(Number.NaN)).toThrow();
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toMinorUnits(-1)).toThrow();
    expect(() => toMinorUnits(0)).toThrow();
  });

  it('refuses an amount above Stripe\'s 8-digit ceiling', () => {
    expect(() => toMinorUnits(1_000_000)).toThrow();
  });

  it('exposes Stripe\'s documented $0.50 minimum', () => {
    expect(STRIPE_MIN_USD_CENTS).toBe(50);
  });
});
