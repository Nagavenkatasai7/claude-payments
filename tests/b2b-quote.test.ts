import { describe, it, expect } from 'vitest';
import { quoteCrossBorderBill } from '@/lib/b2b-quote';
import { sourceForDest, QuoteError } from '@/lib/fx';
import type { FxRates } from '@/lib/rate';

// Live rates are passed IN (the pure helper never fetches). These mirror the
// offline fallback table shape: { toInr, toUsd }. HKD is USD-pegged (~7.8/USD).
const USD: FxRates = { toInr: 85, toUsd: 1 };
const GBP: FxRates = { toInr: 108, toUsd: 1.27 };
const HKD_TO_USD = 0.128; // 1 HKD → USD (≈ 1/7.8125)

describe('quoteCrossBorderBill — inverse cross-border quote (Plan 3)', () => {
  it('HK example: a 1,000 HKD bill → buyerPrincipal ≈ 128 USD, fee on top, seller nets 1,000 HKD', () => {
    const q = quoteCrossBorderBill({
      invoicedAmount: 1000,
      sellerCurrency: 'HKD',
      buyerCurrency: 'USD',
      rates: USD,
      sellerToUsd: HKD_TO_USD,
    });
    expect(q.sellerAmount).toBe(1000);        // EXACT — the seller's obligation
    expect(q.sellerCurrency).toBe('HKD');
    expect(q.buyerPrincipal).toBe(128);        // the buyer-currency FX equivalent
    expect(q.feeBuyer).toBe(1.99);             // B2B flat fee, ON TOP, buyer-bears
    expect(q.buyerTotal).toBe(129.99);         // principal + fee
    expect(q.buyerCurrency).toBe('USD');
    expect(q.fxRate).toBeCloseTo(7.8125, 6);   // USD→HKD cross-rate (≈ the peg)
  });

  it('the seller amount is INVARIANT to the buyer currency (a GBP buyer still owes 1,000 HKD)', () => {
    const usdBuyer = quoteCrossBorderBill({
      invoicedAmount: 1000, sellerCurrency: 'HKD', buyerCurrency: 'USD', rates: USD, sellerToUsd: HKD_TO_USD,
    });
    const gbpBuyer = quoteCrossBorderBill({
      invoicedAmount: 1000, sellerCurrency: 'HKD', buyerCurrency: 'GBP', rates: GBP, sellerToUsd: HKD_TO_USD,
    });
    // Seller nets EXACTLY their stated amount regardless of who pays / in what currency.
    expect(usdBuyer.sellerAmount).toBe(1000);
    expect(gbpBuyer.sellerAmount).toBe(1000);
    // …but the buyer principal differs by corridor.
    expect(gbpBuyer.buyerPrincipal).not.toBe(usdBuyer.buyerPrincipal);
    expect(gbpBuyer.buyerPrincipal).toBeCloseTo(1000 / (1.27 / HKD_TO_USD), 2); // ≈ 100.79 GBP
  });

  it('fee is charged ON TOP of the buyer (buyer-bears); the seller payout is never reduced', () => {
    const q = quoteCrossBorderBill({
      invoicedAmount: 5000, sellerCurrency: 'HKD', buyerCurrency: 'GBP', rates: GBP, sellerToUsd: HKD_TO_USD,
    });
    expect(q.feeBuyer).toBeGreaterThan(0);
    expect(q.buyerTotal).toBeCloseTo(q.buyerPrincipal + q.feeBuyer, 10); // fee strictly added
    expect(q.buyerTotal).toBeGreaterThan(q.buyerPrincipal);
    expect(q.sellerAmount).toBe(5000); // unaffected by the fee
  });

  it('buyerPrincipal equals the remittance engine inverse (sourceForDest) — no math drift', () => {
    const q = quoteCrossBorderBill({
      invoicedAmount: 1000, sellerCurrency: 'HKD', buyerCurrency: 'USD', rates: USD, sellerToUsd: HKD_TO_USD,
    });
    expect(q.buyerPrincipal).toBe(sourceForDest(1000, USD, 'HKD', HKD_TO_USD));
  });

  it('INR seller pivots via the live source→INR rate (an Indian seller billing in INR)', () => {
    const q = quoteCrossBorderBill({
      invoicedAmount: 8500, sellerCurrency: 'INR', buyerCurrency: 'USD', rates: USD, // sellerToUsd omitted ⇒ INR pivot
    });
    expect(q.sellerAmount).toBe(8500);
    expect(q.fxRate).toBe(85);                 // USD→INR
    expect(q.buyerPrincipal).toBe(100);        // 8500 / 85
  });

  it('USD-to-USD bill (same currency) is a clean pass-through + fee', () => {
    const q = quoteCrossBorderBill({
      invoicedAmount: 250, sellerCurrency: 'USD', buyerCurrency: 'USD', rates: USD, sellerToUsd: 1,
    });
    expect(q.fxRate).toBe(1);
    expect(q.buyerPrincipal).toBe(250);
    expect(q.feeBuyer).toBe(1.99);
    expect(q.buyerTotal).toBe(251.99);
    expect(q.sellerAmount).toBe(250);
  });

  describe('QuoteError on bad input', () => {
    it('throws on a non-positive invoiced amount', () => {
      expect(() => quoteCrossBorderBill({
        invoicedAmount: 0, sellerCurrency: 'HKD', buyerCurrency: 'USD', rates: USD, sellerToUsd: HKD_TO_USD,
      })).toThrow(QuoteError);
    });

    it('throws on a negative seller cross-rate', () => {
      expect(() => quoteCrossBorderBill({
        invoicedAmount: 1000, sellerCurrency: 'HKD', buyerCurrency: 'USD', rates: USD, sellerToUsd: -0.128,
      })).toThrow(QuoteError);
    });

    it('throws on a non-finite buyer USD rate', () => {
      expect(() => quoteCrossBorderBill({
        invoicedAmount: 1000, sellerCurrency: 'HKD', buyerCurrency: 'GBP',
        rates: { toInr: 108, toUsd: 0 }, sellerToUsd: HKD_TO_USD,
      })).toThrow(QuoteError);
    });

    it('throws when a non-INR seller has a missing/zero USD rate (no silent INR-pivot mispricing)', () => {
      // A missing sellerToUsd for a non-INR seller must FAIL — never fall through
      // to usdPivotCrossRate's INR branch and price the buyer off rates.toInr.
      expect(() => quoteCrossBorderBill({
        invoicedAmount: 1000, sellerCurrency: 'HKD', buyerCurrency: 'USD', rates: USD,
      })).toThrow(QuoteError);
      expect(() => quoteCrossBorderBill({
        invoicedAmount: 1000, sellerCurrency: 'HKD', buyerCurrency: 'USD', rates: USD, sellerToUsd: 0,
      })).toThrow(QuoteError);
    });
  });
});
