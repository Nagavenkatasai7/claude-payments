import { QuoteError, assertRatesUsable, sourceForDest, usdPivotCrossRate, wouldBeFeeUsd } from './fx';
import type { FxRates } from './rate';
import type { CurrencyCode, FundingMethod } from './types';

// ── Cross-border B2B bill quote (Plan 3) — pure, live-at-payment FX ──────────
//
// TWO denomination models (2026-07-02 spec), both quoted live at payment:
//
// Case S (`quoteCrossBorderBill`, today's model, byte-unchanged): the obligation
// is FIXED in the SELLER'S currency (e.g. 1,000 HKD). The buyer pays the
// FX-converted equivalent in THEIR own currency PLUS fees ON TOP; the seller
// receives their exact stated amount.
// Invariant: `sellerAmount === invoicedAmount` ALWAYS. Rounding of the buyer's
// principal can never reduce the seller's payout — `sellerAmount` is a fixed,
// separately-recorded number (the partner pays it out exactly), so a sub-unit
// rounding remainder is absorbed by the platform/partner, never by the seller.
//
// Case B (`quoteBuyerDenominatedBill`, new): the obligation is FIXED in the
// BUYER'S currency ("bill them 1200 MXN"). The buyer pays EXACTLY the invoiced
// amount PLUS the same flat fee ON TOP; the seller receives the live-converted
// equivalent in their own currency from the SAME locked quote the buyer
// authorizes. The seller-nets-exact guarantee does NOT apply — the seller chose
// to fix the buyer's price instead.
// Invariant: `buyerPrincipal === invoicedAmount` ALWAYS; fees never move it.

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Derives which denomination model governs a bill (2026-07-02 spec) — the ONE
 * authority shared by the pay page, the pay route, and the finalize defense so
 * the three sites can never disagree. 'seller' = Case S (invoiced in the
 * seller's currency; the degenerate S === B domestic bill lands here too).
 * 'buyer' = Case B (invoiced in the buyer's currency). null = a third
 * currency — never payable.
 */
export function billDenomination(
  invoicedCurrency: CurrencyCode,
  sellerCurrency: CurrencyCode,
  buyerCurrency: CurrencyCode,
): 'seller' | 'buyer' | null {
  if (invoicedCurrency === sellerCurrency) return 'seller';
  if (invoicedCurrency === buyerCurrency) return 'buyer';
  return null;
}

export interface CrossBorderBillInput {
  /** The fixed obligation: in the SELLER's currency for `quoteCrossBorderBill`
   *  (Case S, e.g. 1000 HKD) or in the BUYER's currency for
   *  `quoteBuyerDenominatedBill` (Case B, e.g. 1200 MXN). */
  invoicedAmount: number;
  /** The seller's currency (the denomination the seller receives). */
  sellerCurrency: CurrencyCode;
  /** The buyer's currency (what the buyer is debited in). */
  buyerCurrency: CurrencyCode;
  /** The BUYER currency's live FX rates (rates.toUsd = buyer→USD). Passed in — never fetched here. */
  rates: FxRates;
  /** Seller→USD rate (for the USD-pivot cross-rate). REQUIRED for any non-INR, non-USD seller; an INR seller pivots via rates.toInr and a USD seller is 1. */
  sellerToUsd?: number;
  /** The buyer's bank-debit path; defaults to 'ach_pull' (the B2B flat-fee schedule). */
  fundingMethod?: FundingMethod;
}

export interface CrossBorderBillQuote {
  /** The seller's payout in their own currency. Case S: EXACTLY the invoiced
   *  amount (never reduced). Case B: the live-converted equivalent of the
   *  buyer's fixed principal. */
  sellerAmount: number;
  sellerCurrency: CurrencyCode;
  /** The buyer-currency principal. Case S: the FX equivalent whose conversion
   *  delivers `sellerAmount` to the seller. Case B: EXACTLY the invoiced amount. */
  buyerPrincipal: number;
  /** Platform fee charged ON TOP to the buyer (buyer-bears), in the buyer's currency. */
  feeBuyer: number;
  /** What the buyer pays = buyerPrincipal + feeBuyer. */
  buyerTotal: number;
  buyerCurrency: CurrencyCode;
  /** The buyer→seller cross-rate used (seller units per 1 buyer unit) — for display.
   *  SAME orientation in both cases, so the UI reads consistently. */
  fxRate: number;
}

/**
 * Inverse cross-border quote: given the seller's fixed obligation, solve the
 * buyer's pay amount + fees. Reuses the remittance engine's inverse cross-rate
 * (`sourceForDest`, which inverts the same USD-pivot the forward `quote()` uses),
 * so the B2B math can never drift from the corridor engine. Throws `QuoteError`
 * on a non-finite/≤0 amount or rate.
 */
export function quoteCrossBorderBill(input: CrossBorderBillInput): CrossBorderBillQuote {
  const { invoicedAmount, sellerCurrency, buyerCurrency, rates } = input;
  if (!Number.isFinite(invoicedAmount) || invoicedAmount <= 0) {
    throw new QuoteError('Please give a valid bill amount.');
  }
  // Provenance gate (Task 9): never price a bill off the static display table
  // or a rate older than FX_MAX_AGE_MS — throws RateUnavailableError.
  assertRatesUsable(rates);
  // buyer→USD: the SINGLE anchor for BOTH the cross-rate (rates.toUsd, consumed
  // inside sourceForDest/usdPivotCrossRate) AND the buyer-currency fee — so the
  // two legs can never be priced off different USD rates. A USD buyer is exactly
  // 1 (mirrors quote()'s source==='USD' ⇒ toUsd=1).
  const buyerToUsd = buyerCurrency === 'USD' ? 1 : rates.toUsd;
  if (!Number.isFinite(buyerToUsd) || buyerToUsd <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  // seller→USD: a USD seller pivots at 1; an INR seller pivots via rates.toInr
  // inside sourceForDest/usdPivotCrossRate (sellerToUsd unused). EVERY OTHER
  // seller currency REQUIRES a finite, positive sellerToUsd — without this guard a
  // missing/0/NaN rate would silently fall into the INR-pivot branch and misprice
  // the buyer off the wrong cross-rate instead of failing (the seller stays whole
  // but the platform would eat the gap). Fail loud, as the spec requires.
  const sellerToUsd = sellerCurrency === 'USD' ? 1 : input.sellerToUsd;
  if (sellerCurrency !== 'INR' && (!Number.isFinite(sellerToUsd) || (sellerToUsd as number) <= 0)) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }

  // buyerPrincipal: the buyer-currency amount whose conversion delivers EXACTLY
  // invoicedAmount in the seller currency (the inverse cross-rate). sourceForDest
  // validates + throws QuoteError on a bad cross-rate.
  const buyerPrincipal = sourceForDest(invoicedAmount, rates, sellerCurrency, sellerToUsd);
  // The same cross-rate, for display (single-sourced via usdPivotCrossRate — the
  // exact rate sourceForDest just inverted, so the two cannot disagree).
  const fxRate = usdPivotCrossRate(rates, sellerCurrency, sellerToUsd);

  // Buyer-bears fee: the flat B2B bank-debit fee (USD), converted to the buyer's
  // currency. The fee is added ON TOP of the principal — the seller's payout is
  // unaffected. Defense-in-depth (mirrors quote()'s explicit enum guard): an
  // out-of-schema funding method cast to FundingMethod makes wouldBeFeeUsd return
  // undefined → NaN; never emit a NaN-priced quote.
  const feeUsd = wouldBeFeeUsd(round2(buyerPrincipal * buyerToUsd), input.fundingMethod ?? 'ach_pull');
  if (!Number.isFinite(feeUsd)) {
    throw new QuoteError('Please choose how to pay: credit card, debit card, or bank transfer.');
  }
  const feeBuyer = round2(feeUsd / buyerToUsd);

  return {
    sellerAmount: invoicedAmount,
    sellerCurrency,
    buyerPrincipal,
    feeBuyer,
    buyerTotal: round2(buyerPrincipal + feeBuyer),
    buyerCurrency,
    fxRate,
  };
}

/**
 * Case B — the obligation is FIXED in the BUYER's currency. The buyer pays
 * EXACTLY `invoicedAmount` (+ the same flat B2B fee on top); the seller receives
 * the FORWARD conversion `round2(invoicedAmount × crossRate(B→S))` — the very
 * cross-rate Case S inverts (single-sourced via `usdPivotCrossRate`), so the two
 * models can never price off different rates. Same guards, same output shape,
 * same displayed `fxRate` orientation as Case S. `quoteCrossBorderBill` is
 * untouched — Case S stays byte-identical.
 */
export function quoteBuyerDenominatedBill(input: CrossBorderBillInput): CrossBorderBillQuote {
  const { invoicedAmount, sellerCurrency, buyerCurrency, rates } = input;
  if (!Number.isFinite(invoicedAmount) || invoicedAmount <= 0) {
    throw new QuoteError('Please give a valid bill amount.');
  }
  // Provenance gate (Task 9) — Case B multiplies usdPivotCrossRate directly
  // below, so nothing downstream would otherwise check where the rate came from.
  assertRatesUsable(rates);
  // buyer→USD: the SINGLE anchor for BOTH the cross-rate and the buyer-currency
  // fee (mirrors Case S). A USD buyer is exactly 1.
  const buyerToUsd = buyerCurrency === 'USD' ? 1 : rates.toUsd;
  if (!Number.isFinite(buyerToUsd) || buyerToUsd <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  // seller→USD: same fail-loud guard as Case S — a missing/0/NaN rate for a
  // non-INR, non-USD seller must never fall into the INR-pivot branch (here it
  // would silently misprice the SELLER's payout off the wrong cross-rate).
  const sellerToUsd = sellerCurrency === 'USD' ? 1 : input.sellerToUsd;
  if (sellerCurrency !== 'INR' && (!Number.isFinite(sellerToUsd) || (sellerToUsd as number) <= 0)) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }

  // The forward B→S cross-rate (seller units per 1 buyer unit) — the SAME
  // usdPivotCrossRate Case S displays and inverts. Guarded like quote() because
  // this path multiplies by it directly (nothing upstream validates it here).
  const fxRate = usdPivotCrossRate(rates, sellerCurrency, sellerToUsd);
  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }

  // buyerPrincipal: EXACTLY the invoiced amount — the fixed side of Case B.
  const buyerPrincipal = invoicedAmount;
  // sellerAmount: the live-converted payout in the seller's currency, from the
  // same quote the buyer locks — what-you-see-is-what-you-pay on BOTH sides.
  const sellerAmount = round2(invoicedAmount * fxRate);

  // Buyer-bears fee: identical derivation to Case S — the flat B2B USD fee
  // converted to the buyer's currency, ON TOP; the fixed principal is untouched.
  const feeUsd = wouldBeFeeUsd(round2(buyerPrincipal * buyerToUsd), input.fundingMethod ?? 'ach_pull');
  if (!Number.isFinite(feeUsd)) {
    throw new QuoteError('Please choose how to pay: credit card, debit card, or bank transfer.');
  }
  const feeBuyer = round2(feeUsd / buyerToUsd);

  return {
    sellerAmount,
    sellerCurrency,
    buyerPrincipal,
    feeBuyer,
    buyerTotal: round2(buyerPrincipal + feeBuyer),
    buyerCurrency,
    fxRate,
  };
}
