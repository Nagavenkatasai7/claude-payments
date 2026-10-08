import { describe, it, expect } from 'vitest';
import { quote, MAX_USD } from '@/lib/fx';
import type { FxRates } from '@/lib/rate';
import type { FundingMethod } from '@/lib/types';

// B3 rewards v1: quote() takes an OPTIONAL pricing input. Without it the
// prices are exactly today's; with it only the fee moves (never below $0).

const USD: FxRates = { toInr: 85, toUsd: 1 };
const GBP: FxRates = { toInr: 108, toUsd: 1.27 };
const METHODS: FundingMethod[] = ['bank_transfer', 'debit_card', 'credit_card', 'ach_pull', 'bank_pull'];

describe('quote() pricing input (B3)', () => {
  it('no pricing input ⇒ byte-for-byte today’s quote (every method, both tiers, both corridors)', () => {
    for (const m of METHODS) {
      for (const count of [0, 1, 7]) {
        expect(quote(200, 'USD', USD, m, count)).toEqual(quote(200, 'USD', USD, m, count, 'INR', undefined, MAX_USD, undefined));
        expect(JSON.stringify(quote(150, 'GBP', GBP, m, count, 'AED', 0.2723))).toBe(
          JSON.stringify(quote(150, 'GBP', GBP, m, count, 'AED', 0.2723, MAX_USD, undefined)),
        );
      }
    }
    // the pinned figures of today's schedule
    expect(quote(200, 'USD', USD, 'bank_transfer', 1)).toMatchObject({ feeUsd: 1.99, totalChargeUsd: 201.99, feeSource: 1.99 });
    expect(quote(200, 'USD', USD, 'credit_card', 1)).toMatchObject({ feeUsd: 8.99, totalChargeUsd: 208.99 });
  });

  it('a zero discount changes nothing', () => {
    expect(quote(200, 'USD', USD, 'debit_card', 3, 'INR', undefined, MAX_USD, { feeDiscountUsd: 0 }))
      .toEqual(quote(200, 'USD', USD, 'debit_card', 3));
  });

  it('the fee never goes below $0', () => {
    const q = quote(200, 'USD', USD, 'bank_transfer', 4, 'INR', undefined, MAX_USD, { feeDiscountUsd: 5 });
    expect(q.feeUsd).toBe(0);
    expect(q.feeSource).toBe(0);
    expect(q.totalChargeUsd).toBe(200);
    expect(q.totalChargeSource).toBe(200);
  });

  it('card fee %: a capped discount leaves the percentage part charged', () => {
    const q = quote(200, 'USD', USD, 'credit_card', 4, 'INR', undefined, MAX_USD, { feeDiscountUsd: 2.99 });
    expect(q.feeUsd).toBe(6); // 2.99 + 3% of 200 = 8.99, minus 2.99
    expect(q.totalChargeUsd).toBe(206);
  });

  it('the amount sent, the rate and the amount received never change', () => {
    for (const m of METHODS) {
      const base = quote(150, 'GBP', GBP, m, 4, 'AED', 0.2723);
      const off = quote(150, 'GBP', GBP, m, 4, 'AED', 0.2723, MAX_USD, { feeDiscountUsd: 1.99 });
      expect([off.amountUsd, off.amountSource, off.fxRate, off.amountInr, off.destinationCurrency, off.deliveryEstimate])
        .toEqual([base.amountUsd, base.amountSource, base.fxRate, base.amountInr, base.destinationCurrency, base.deliveryEstimate]);
      expect(off.feeUsd).toBe(Math.max(0, Math.round((base.feeUsd - 1.99) * 100) / 100));
      expect(off.totalChargeSource).toBe(Math.round((off.amountSource + off.feeSource) * 100) / 100);
    }
  });

  it('a non-finite or negative discount is ignored (today’s price)', () => {
    for (const d of [NaN, -1, Infinity]) {
      expect(quote(200, 'USD', USD, 'bank_transfer', 4, 'INR', undefined, MAX_USD, { feeDiscountUsd: d }).feeUsd).toBe(1.99);
    }
  });
});
