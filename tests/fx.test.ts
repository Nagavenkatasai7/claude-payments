import { describe, it, expect } from 'vitest';
import { quote, QuoteError, MIN_USD, MAX_USD } from '@/lib/fx';
import type { FxRates } from '@/lib/rate';

const USD: FxRates = { toInr: 85, toUsd: 1 };
const GBP: FxRates = { toInr: 108, toUsd: 1.27 };

describe('quote (USD source — regression: identical to pre-P4)', () => {
  it('first transfer is free; amounts equal source amounts', () => {
    const q = quote(100, 'USD', USD, 'bank_transfer', 0);
    expect(q.amountUsd).toBe(100);
    expect(q.amountSource).toBe(100);
    expect(q.feeUsd).toBe(0);
    expect(q.feeSource).toBe(0);
    expect(q.amountInr).toBe(8500);
    expect(q.fxRate).toBe(85);
    expect(q.sourceCurrency).toBe('USD');
  });

  it('applies the funding-method fee after the first transfer', () => {
    expect(quote(100, 'USD', USD, 'bank_transfer', 1).feeUsd).toBe(1.99);
    expect(quote(100, 'USD', USD, 'debit_card', 1).feeUsd).toBe(2.99);
    expect(quote(100, 'USD', USD, 'credit_card', 1).feeUsd).toBe(5.99); // 2.99 + 3%·100
  });
});

describe('quote (non-USD source)', () => {
  it('converts to USD-equivalent for fee/min-max and to INR for payout', () => {
    const q = quote(200, 'GBP', GBP, 'bank_transfer', 1);
    expect(q.amountSource).toBe(200);
    expect(q.sourceCurrency).toBe('GBP');
    expect(q.amountUsd).toBe(254); // 200 × 1.27
    expect(q.amountInr).toBe(21600); // 200 × 108
    expect(q.feeUsd).toBe(1.99);
    expect(q.feeSource).toBe(1.57); // 1.99 / 1.27, rounded to 2dp
    expect(q.totalChargeSource).toBe(201.57);
  });

  it('enforces MIN_USD/MAX_USD on the USD-equivalent', () => {
    expect(() => quote(5, 'GBP', GBP, 'bank_transfer', 0)).toThrow(QuoteError); // 5×1.27=6.35 < 10
    expect(MIN_USD).toBe(10);
    expect(MAX_USD).toBe(2999);
  });
});

describe('quote (input guards)', () => {
  it('rejects non-finite source amounts', () => {
    expect(() => quote(NaN, 'USD', USD, 'bank_transfer', 0)).toThrow(QuoteError);
    expect(() => quote(Infinity, 'USD', USD, 'bank_transfer', 0)).toThrow(QuoteError);
  });
  it('rejects an unknown funding method on a repeat transfer', () => {
    expect(() => quote(500, 'USD', USD, 'paypal' as never, 1)).toThrow(QuoteError);
  });
  it('rejects a NaN exchange rate (corrupt FxRates)', () => {
    expect(() => quote(100, 'GBP', { toInr: 108, toUsd: NaN }, 'bank_transfer', 0)).toThrow(QuoteError);
  });
});

describe('quote (non-USD coverage)', () => {
  it('non-USD first transfer is free', () => {
    const q = quote(200, 'GBP', GBP, 'bank_transfer', 0);
    expect(q.feeSource).toBe(0);
    expect(q.totalChargeSource).toBe(200);
  });
  it('non-USD credit-card fee converts to source currency', () => {
    const q = quote(100, 'GBP', GBP, 'credit_card', 1);
    expect(q.amountUsd).toBe(127);       // 100 × 1.27
    expect(q.feeUsd).toBe(6.8);          // 2.99 + 0.03×127
    expect(q.feeSource).toBe(5.35);      // 6.8 / 1.27
  });
  it('enforces MAX_USD on the USD-equivalent for a non-USD source', () => {
    expect(() => quote(2362, 'GBP', GBP, 'bank_transfer', 0)).toThrow(QuoteError); // 2362×1.27=2999.74 > 2999
  });
});
