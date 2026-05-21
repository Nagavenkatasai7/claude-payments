import { describe, it, expect } from 'vitest';
import { quote, QuoteError, FX_RATE, REPEAT_FEE_USD } from '@/lib/fx';

describe('quote', () => {
  it('charges no fee on the first transfer', () => {
    const q = quote(500, 'upi', 0);
    expect(q.feeUsd).toBe(0);
    expect(q.totalChargeUsd).toBe(500);
  });

  it('charges the repeat fee on later transfers', () => {
    const q = quote(500, 'upi', 1);
    expect(q.feeUsd).toBe(REPEAT_FEE_USD);
    expect(q.totalChargeUsd).toBe(502.99);
  });

  it('converts USD to INR at the fixed rate, rounded', () => {
    const q = quote(100, 'upi', 0);
    expect(q.fxRate).toBe(FX_RATE);
    expect(q.amountInr).toBe(Math.round(100 * FX_RATE));
  });

  it('gives a faster delivery estimate for UPI than bank', () => {
    expect(quote(100, 'upi', 0).deliveryEstimate).toMatch(/minute/i);
    expect(quote(100, 'bank', 0).deliveryEstimate).toMatch(/hour/i);
  });

  it('rejects amounts below the minimum', () => {
    expect(() => quote(5, 'upi', 0)).toThrow(QuoteError);
  });

  it('rejects amounts above the maximum', () => {
    expect(() => quote(5000, 'upi', 0)).toThrow(QuoteError);
  });
});
