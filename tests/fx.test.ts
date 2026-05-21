import { describe, it, expect } from 'vitest';
import { quote, QuoteError, MIN_USD, MAX_USD } from '@/lib/fx';

const RATE = 85.0;

describe('quote', () => {
  it('charges no fee on the first transfer (any method)', () => {
    expect(quote(500, RATE, 'bank_transfer', 0).feeUsd).toBe(0);
    expect(quote(500, RATE, 'debit_card', 0).feeUsd).toBe(0);
    expect(quote(500, RATE, 'credit_card', 0).feeUsd).toBe(0);
  });

  it('first transfer has totalChargeUsd equal to amountUsd', () => {
    const q = quote(500, RATE, 'bank_transfer', 0);
    expect(q.totalChargeUsd).toBe(500);
  });

  it('bank_transfer repeat fee is 1.99', () => {
    const q = quote(500, RATE, 'bank_transfer', 1);
    expect(q.feeUsd).toBe(1.99);
    expect(q.totalChargeUsd).toBe(501.99);
  });

  it('debit_card repeat fee is 2.99', () => {
    const q = quote(500, RATE, 'debit_card', 1);
    expect(q.feeUsd).toBe(2.99);
    expect(q.totalChargeUsd).toBe(502.99);
  });

  it('credit_card repeat fee is 2.99 + 3% surcharge', () => {
    const q = quote(500, RATE, 'credit_card', 1);
    // 2.99 + 0.03 * 500 = 2.99 + 15 = 17.99
    expect(q.feeUsd).toBe(17.99);
    expect(q.totalChargeUsd).toBe(517.99);
  });

  it('rounds feeUsd and totalChargeUsd to 2 decimals', () => {
    // amount=100, credit_card repeat: 2.99 + 3 = 5.99, total = 105.99
    const q = quote(100, RATE, 'credit_card', 1);
    expect(q.feeUsd).toBe(5.99);
    expect(q.totalChargeUsd).toBe(105.99);
  });

  it('converts USD to INR at the given rate, rounded', () => {
    const q = quote(100, RATE, 'bank_transfer', 0);
    expect(q.fxRate).toBe(RATE);
    expect(q.amountInr).toBe(Math.round(100 * RATE));
  });

  it('uses the passed-in fxRate for amountInr', () => {
    const q = quote(100, 90.5, 'bank_transfer', 0);
    expect(q.fxRate).toBe(90.5);
    expect(q.amountInr).toBe(Math.round(100 * 90.5));
  });

  it('delivery estimate is always "within 10 minutes"', () => {
    expect(quote(100, RATE, 'bank_transfer', 0).deliveryEstimate).toBe('within 10 minutes');
    expect(quote(100, RATE, 'debit_card', 0).deliveryEstimate).toBe('within 10 minutes');
    expect(quote(100, RATE, 'credit_card', 0).deliveryEstimate).toBe('within 10 minutes');
    expect(quote(100, RATE, 'bank_transfer', 1).deliveryEstimate).toBe('within 10 minutes');
  });

  it('rejects amounts below the minimum', () => {
    expect(() => quote(5, RATE, 'bank_transfer', 0)).toThrow(QuoteError);
  });

  it('rejects amounts above the maximum', () => {
    expect(() => quote(5000, RATE, 'bank_transfer', 0)).toThrow(QuoteError);
  });

  it('rejects non-finite amounts', () => {
    expect(() => quote(NaN, RATE, 'bank_transfer', 0)).toThrow(QuoteError);
    expect(() => quote(Infinity, RATE, 'bank_transfer', 0)).toThrow(QuoteError);
  });

  it('rejects an unknown funding method on a repeat transfer', () => {
    // simulates the LLM passing a value outside the schema enum
    expect(() =>
      quote(500, RATE, 'paypal' as unknown as never, 1),
    ).toThrow(QuoteError);
  });

  it('exports MIN_USD and MAX_USD', () => {
    expect(MIN_USD).toBe(10);
    expect(MAX_USD).toBe(2999);
  });
});
