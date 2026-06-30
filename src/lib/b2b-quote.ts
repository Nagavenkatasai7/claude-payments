import { QuoteError, sourceForDest, usdPivotCrossRate, wouldBeFeeUsd } from './fx';
import type { FxRates } from './rate';
import type { CurrencyCode, FundingMethod } from './types';

// ── Cross-border B2B bill quote (Plan 3) — pure, live-at-payment FX ──────────
//
// The money model: a bill's obligation is FIXED in the SELLER'S currency (e.g.
// 1,000 HKD). The buyer pays the FX-converted equivalent in THEIR own currency
// PLUS fees ON TOP; the seller receives their exact stated amount. FX is quoted
// LIVE at payment (the caller passes today's `rates` — this helper never fetches).
//
// Invariant: `sellerAmount === invoicedAmount` ALWAYS. Rounding of the buyer's
// principal can never reduce the seller's payout — `sellerAmount` is a fixed,
// separately-recorded number (the partner pays it out exactly), so a sub-unit
// rounding remainder is absorbed by the platform/partner, never by the seller.

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface CrossBorderBillInput {
  /** The seller's fixed obligation, in the seller's currency (e.g. 1000 HKD). */
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
  /** EXACTLY the invoiced amount — the seller's payout is never reduced. */
  sellerAmount: number;
  sellerCurrency: CurrencyCode;
  /** Buyer-currency amount whose FX conversion delivers `sellerAmount` to the seller. */
  buyerPrincipal: number;
  /** Platform fee charged ON TOP to the buyer (buyer-bears), in the buyer's currency. */
  feeBuyer: number;
  /** What the buyer pays = buyerPrincipal + feeBuyer. */
  buyerTotal: number;
  buyerCurrency: CurrencyCode;
  /** The buyer→seller cross-rate used (seller units per 1 buyer unit) — for display. */
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
