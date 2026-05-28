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
