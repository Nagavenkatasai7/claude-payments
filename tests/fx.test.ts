import { describe, it, expect } from 'vitest';
import {
  sourceForInr, sourceForDest, quote, QuoteError, MIN_USD, MAX_USD, wouldBeFeeUsd,
  usdPivotCrossRate, assertRatesUsable,
} from '@/lib/fx';
import { SEND_LIMIT_HARD_CEILING_CENTS } from '@/lib/send-limits';
import { FALLBACK_FX_RATES, FX_MAX_AGE_MS, RateUnavailableError, type FxRates } from '@/lib/rate';

const USD: FxRates = { toInr: 85, toUsd: 1 };
const GBP: FxRates = { toInr: 108, toUsd: 1.27 };
const INR: FxRates = { toInr: 1, toUsd: 0.0118 }; // INR source: identity toInr, live-ish toUsd

describe('any-to-any: sourceForDest (cross-rate-aware receive-first back-solve)', () => {
  it('INR destination is byte-for-byte identical to sourceForInr (regression)', () => {
    expect(sourceForDest(42500, USD, 'INR', undefined)).toBe(sourceForInr(42500, USD));
    expect(sourceForDest(42500, USD, 'INR', undefined)).toBe(500);
  });
  it('INR→USD: back-solves the SEND in rupees from a USD receive target via the cross-rate', () => {
    // INR→USD cross = toUsd(INR)/destToUsd(USD=1) = 0.0118. To receive $250, send 250/0.0118 ≈ ₹21,186.
    const src = sourceForDest(250, INR, 'USD', 1);
    expect(src).toBeCloseTo(250 / 0.0118, 0);
    // round-trips: quote() gives the recipient back ~$250.
    const q = quote(src, 'INR', INR, 'bank_transfer', 0, 'USD', 1);
    expect(q.destinationCurrency).toBe('USD');
    expect(q.amountInr).toBeCloseTo(250, 0); // recipient receives ~$250 (amountInr holds the dest amount)
  });
  it('USD→AED: inverts the USD-pivot cross-rate (not ÷toInr)', () => {
    // USD source, AED destination (destToUsd=0.27). Cross = toUsd(USD=1)/0.27 = 3.7037.
    // To receive AED 1000, send 1000/3.7037 ≈ $270 — NOT 1000/toInr(85)=$11.76 (the old bug).
    expect(sourceForDest(1000, USD, 'AED', 0.27)).toBeCloseTo(1000 / (1 / 0.27), 1);
  });
});

describe('any-to-any: out-of-range refusal is stated in the SENDER currency', () => {
  it('USD source keeps the exact legacy dollar message (byte-for-byte)', () => {
    expect(() => quote(5, 'USD', USD, 'bank_transfer', 0)).toThrow('Transfers must be between $10 and $2999.');
  });
  it('INR source states the range in rupees, never in dollars', () => {
    // ₹210 ≈ $2.48 → below the $10 floor (the exact 6/16 production failure).
    try {
      quote(210, 'INR', INR, 'bank_transfer', 0, 'USD', 1);
      throw new Error('expected QuoteError');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('₹');
      expect(msg).not.toContain('$10');
    }
  });
});

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

describe('sourceForInr — back-solve send amount from a target rupee amount', () => {
  it('is the inverse of the forward amountInr line for USD', () => {
    // forward: 500 * 85 = 42500; inverse of 42500 must round-trip to ~500
    expect(sourceForInr(42500, USD)).toBe(500);
  });
  it('back-solves a non-USD source currency (GBP)', () => {
    // 108 INR per GBP; 21600 / 108 = 200
    expect(sourceForInr(21600, GBP)).toBe(200);
  });
  it('rounds the source amount to 2 dp (cents), like round2', () => {
    // 40000 / 85 = 470.588... → 470.59
    expect(sourceForInr(40000, USD)).toBe(470.59);
  });
  it('round-trips through quote(): the recipient gets ~the requested INR', () => {
    const src = sourceForInr(40000, USD);            // 470.59
    const q = quote(src, 'USD', USD, 'bank_transfer', 1);
    expect(q.amountInr).toBe(Math.round(470.59 * 85)); // 40000 (±1 from cent rounding)
  });
  it('throws QuoteError on a non-finite target', () => {
    expect(() => sourceForInr(Number.NaN, USD)).toThrow(QuoteError);
    expect(() => sourceForInr(Number.POSITIVE_INFINITY, USD)).toThrow(QuoteError);
  });
  it('throws QuoteError on a non-positive target', () => {
    expect(() => sourceForInr(0, USD)).toThrow(QuoteError);
    expect(() => sourceForInr(-100, USD)).toThrow(QuoteError);
  });
});

describe('wouldBeFeeUsd — the repeat-send fee (for first-transfer-free framing)', () => {
  it('bank_transfer → 1.99, debit_card → 2.99', () => {
    expect(wouldBeFeeUsd(500, 'bank_transfer')).toBe(1.99);
    expect(wouldBeFeeUsd(500, 'debit_card')).toBe(2.99);
  });
  it('credit_card → 2.99 + 3% of the amount (matches quote()\'s schedule)', () => {
    expect(wouldBeFeeUsd(500, 'credit_card')).toBe(17.99); // round2(2.99 + 0.03*500)
    expect(wouldBeFeeUsd(100, 'credit_card')).toBe(5.99);
  });
  // Lock the duplicated fee schedule to quote()'s own: wouldBeFeeUsd re-states the
  // bank/debit/credit constants for the first-transfer-free framing, so assert it
  // equals quote()'s repeat-send feeUsd across every funding method and a few
  // amounts. If quote()'s schedule ever changes, this fails until both agree —
  // the constants can't silently drift apart.
  it('equals quote()\'s repeat-send feeUsd for every funding method (no drift)', () => {
    const methods = ['bank_transfer', 'debit_card', 'credit_card'] as const;
    for (const amt of [100, 500, 2999]) {
      for (const m of methods) {
        expect(wouldBeFeeUsd(amt, m)).toBe(quote(amt, 'USD', USD, m, 1).feeUsd);
      }
    }
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

// ── Program fix 16b (Task 10b, test 9): the per-sender quote ceiling ──────
describe('quote — per-sender quote ceiling (fix 16b, ruling 12 amended)', () => {
  const LEGACY_MSG = 'Transfers must be between $10 and $2999.';

  it('the DEFAULT path is byte-for-byte unchanged: $3,000 throws the legacy message', () => {
    expect(() => quote(3000, 'USD', USD, 'bank_transfer', 0)).toThrow(QuoteError);
    expect(() => quote(3000, 'USD', USD, 'bank_transfer', 0)).toThrow(LEGACY_MSG);
    expect(() => quote(2999, 'USD', USD, 'bank_transfer', 0)).not.toThrow();
    // Passing the platform max explicitly is the same path.
    expect(() => quote(3000, 'USD', USD, 'bank_transfer', 0, 'INR', undefined, MAX_USD)).toThrow(LEGACY_MSG);
  });

  it('$4,000 with a trailing maxUsd of 5000 succeeds; $5,001 is refused with the raised figure', () => {
    const q = quote(4000, 'USD', USD, 'bank_transfer', 1, 'INR', undefined, 5000);
    expect(q.amountUsd).toBe(4000);
    expect(q.amountInr).toBe(4000 * 85);
    expect(() => quote(5001, 'USD', USD, 'bank_transfer', 1, 'INR', undefined, 5000)).toThrow('Transfers must be between $10 and $5000.');
  });

  it('the trailing maxUsd is ALWAYS clamped to the $10,000 hard ceiling; garbage falls back to MAX_USD', () => {
    expect(SEND_LIMIT_HARD_CEILING_CENTS / 100).toBe(10_000);
    expect(() => quote(10_000, 'USD', USD, 'bank_transfer', 1, 'INR', undefined, 50_000)).not.toThrow();
    expect(() => quote(10_001, 'USD', USD, 'bank_transfer', 1, 'INR', undefined, 50_000)).toThrow('Transfers must be between $10 and $10000.');
    for (const garbage of [NaN, 0, -1, Infinity]) {
      expect(() => quote(3000, 'USD', USD, 'bank_transfer', 1, 'INR', undefined, garbage)).toThrow(LEGACY_MSG);
    }
  });

  it('a non-USD sender sees the raised range in their own currency', () => {
    // GBP: toUsd 1.27 ⇒ max £floor(5000/1.27) = £3937
    expect(() => quote(3900, 'GBP', GBP, 'bank_transfer', 1, 'INR', undefined, 5000)).not.toThrow();
    expect(() => quote(4000, 'GBP', GBP, 'bank_transfer', 1, 'INR', undefined, 5000)).toThrow('Transfers must be between £8 and £3,937.');
  });
});

describe('quote — cross-rate invariant: negative destToUsd must throw (regression)', () => {
  // Bug: quote() did not guard crossRate for non-finite / non-positive values.
  // sourceForDest() correctly throws; quote() silently returned a negative fxRate + amountInr.
  it('throws QuoteError when destToUsd is negative (cross-rate becomes negative)', () => {
    // AED with destToUsd=-0.27 → crossRate = 1 / -0.27 = -3.7037 (negative)
    expect(() =>
      quote(100, 'USD', { toInr: 85, toUsd: 1 }, 'bank_transfer', 0, 'AED', -0.27),
    ).toThrow(QuoteError);
  });

  it('throws QuoteError when a very small negative destToUsd also produces a negative crossRate', () => {
    // Any negative destToUsd → crossRate = toUsd / negative = negative
    expect(() =>
      quote(100, 'USD', { toInr: 85, toUsd: 1 }, 'bank_transfer', 0, 'AED', -0.001),
    ).toThrow(QuoteError);
  });

  it('the thrown message matches the standard rate-error string', () => {
    expect(() =>
      quote(100, 'USD', { toInr: 85, toUsd: 1 }, 'bank_transfer', 0, 'AED', -0.27),
    ).toThrow('Invalid exchange rate; please try again.');
  });
});

describe('quote — any-to-any cross-currency destination', () => {
  const USD2 = { toInr: 85, toUsd: 1 };
  it('USD→INR is byte-for-byte the legacy result (5-arg call defaults to INR)', () => {
    const q = quote(500, 'USD', USD2, 'bank_transfer', 1);
    expect(q.amountInr).toBe(42500);
    expect(q.fxRate).toBe(85);
    expect(q.destinationCurrency).toBe('INR');
    expect(q.amountUsd).toBe(500);
  });
  it('USD→AED uses the USD-pivot cross-rate', () => {
    const q = quote(500, 'USD', USD2, 'bank_transfer', 1, 'AED', 0.27); // AED.toUsd
    expect(q.destinationCurrency).toBe('AED');
    expect(q.fxRate).toBeCloseTo(1 / 0.27, 3);     // ≈3.70
    expect(q.amountInr).toBe(Math.round(500 * (1 / 0.27))); // dest amount in AED ≈1852
    expect(q.amountUsd).toBe(500);                  // caps still USD-equiv
  });
  it('INR→AED (sender in India) cross-converts via USD pivot', () => {
    const INR = { toInr: 1, toUsd: 0.0118 };
    const q = quote(10000, 'INR', INR, 'bank_transfer', 1, 'AED', 0.27);
    expect(q.destinationCurrency).toBe('AED');
    expect(q.amountUsd).toBe(118);                  // 10000×0.0118, within MIN/MAX
    expect(q.amountInr).toBe(Math.round(10000 * (0.0118 / 0.27))); // ≈437 AED
  });
  it('explicit INR destination matches the default path', () => {
    const q = quote(500, 'USD', USD2, 'bank_transfer', 1, 'INR', 0.0118);
    expect(q.amountInr).toBe(42500); // INR branch uses rates.toInr, ignores destToUsd
    expect(q.fxRate).toBe(85);
  });
});

describe('Task 9 / prs-04: a destination USD rate of 0 is a refusal, never a silent INR-branch quote', () => {
  it('quote(100, USD, {85,1}, …, AED, 0) throws (audit repro: returned fxRate 85 / amountInr 8500 labelled AED)', () => {
    expect(() => quote(100, 'USD', USD, 'bank_transfer', 0, 'AED', 0)).toThrow(QuoteError);
    expect(() => quote(100, 'USD', USD, 'bank_transfer', 0, 'AED', 0)).toThrow('Invalid exchange rate; please try again.');
  });

  it('sourceForDest with destToUsd 0 throws (audit repro: returned 2.94 — 250 ÷ toInr)', () => {
    expect(() => sourceForDest(250, USD, 'AED', 0)).toThrow(QuoteError);
  });

  it('usdPivotCrossRate: null/undefined keeps the INR branch; 0, NaN and negatives throw', () => {
    expect(usdPivotCrossRate(USD, 'INR', undefined)).toBe(85);
    expect(usdPivotCrossRate(USD, 'INR', 0)).toBe(85); // INR destination never reads destToUsd
    expect(() => usdPivotCrossRate(USD, 'AED', 0)).toThrow(QuoteError);
    expect(() => usdPivotCrossRate(USD, 'AED', Number.NaN)).toThrow(QuoteError);
    expect(() => usdPivotCrossRate(USD, 'AED', -1)).toThrow(QuoteError);
    expect(usdPivotCrossRate(USD, 'AED', 1 / 3.6725)).toBeCloseTo(3.6725, 10);
  });
});

describe('Task 9 / money-07: the provenance gate — never price off the display table or a rate beyond the ceiling', () => {
  const stale = (): FxRates => ({ toInr: 85, toUsd: 1, fetchedAt: Date.now() - FX_MAX_AGE_MS - 1, source: 'cache' });
  const fresh = (): FxRates => ({ toInr: 95.82, toUsd: 1, fetchedAt: Date.now(), source: 'live' });

  it('quote() refuses a rate whose fetchedAt is beyond FX_MAX_AGE_MS', () => {
    expect(() => quote(100, 'USD', stale(), 'bank_transfer', 0)).toThrow(RateUnavailableError);
  });

  it('quote() refuses the static display table unconditionally (source: fallback)', () => {
    expect(() => quote(100, 'USD', FALLBACK_FX_RATES.USD, 'bank_transfer', 0)).toThrow(RateUnavailableError);
  });

  it('sourceForDest() and sourceForInr() apply the same gate', () => {
    expect(() => sourceForDest(8500, stale())).toThrow(RateUnavailableError);
    expect(() => sourceForInr(8500, FALLBACK_FX_RATES.USD)).toThrow(RateUnavailableError);
  });

  it('RateUnavailableError is NOT a QuoteError (every QuoteError arm needs a sibling arm)', () => {
    let caught: unknown;
    try { quote(100, 'USD', stale(), 'bank_transfer', 0); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RateUnavailableError);
    expect(caught).not.toBeInstanceOf(QuoteError);
  });

  it('a fresh live rate and a provenance-less literal both still quote', () => {
    expect(quote(100, 'USD', fresh(), 'bank_transfer', 0).amountInr).toBe(9582);
    expect(quote(100, 'USD', USD, 'bank_transfer', 0).amountInr).toBe(8500);
  });

  it('assertRatesUsable: reason fallback_table / stale; exactly at the ceiling is still usable', () => {
    const now = Date.now();
    expect(() => assertRatesUsable(FALLBACK_FX_RATES.GBP, now)).toThrow(expect.objectContaining({ reason: 'fallback_table' }));
    expect(() => assertRatesUsable({ ...fresh(), fetchedAt: now - FX_MAX_AGE_MS - 1 }, now)).toThrow(expect.objectContaining({ reason: 'stale' }));
    expect(() => assertRatesUsable({ ...fresh(), fetchedAt: now - FX_MAX_AGE_MS }, now)).not.toThrow();
  });
});
