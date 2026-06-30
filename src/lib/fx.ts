import type { CurrencyCode, FundingMethod, Quote } from './types';
import type { FxRates } from './rate';

export const MIN_USD = 10;
export const MAX_USD = 2999;

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteError';
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The source→destination cross-rate via the USD pivot — the single source of the
 * FX cross-rate used by BOTH the forward quote() and the inverse sourceForDest().
 * For an INR destination (or when no dest USD rate is supplied) this is the live
 * source→INR rate (rates.toInr) — byte-for-byte the pre-any-to-any behavior;
 * otherwise it pivots through USD: src->dest = src.toUsd / dest.toUsd. NOT
 * validated here (callers guard finiteness/positivity where it matters).
 */
export function usdPivotCrossRate(
  rates: FxRates,
  destinationCurrency: CurrencyCode = 'INR',
  destToUsd?: number,
): number {
  return destinationCurrency === 'INR' || !destToUsd || !Number.isFinite(destToUsd)
    ? rates.toInr
    : rates.toUsd / destToUsd;
}

/** Format a whole amount in the given ISO-4217 currency ($, ₹, £, AED, …). */
function fmtAmount(amount: number, currency: CurrencyCode): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * The MIN/MAX band is enforced on the USD-equivalent, but the refusal is stated
 * in the SENDER's currency so a non-USD sender sees a figure they understand
 * (any-to-any: e.g. an INR sender gets "between ₹X and ₹Y", not "$10 and $2,999").
 * USD source keeps the exact legacy string (byte-for-byte). The source bound is
 * rounded so the stated range never admits a value that then fails the USD check.
 */
function limitMessage(sourceCurrency: CurrencyCode, rates: FxRates): string {
  if (sourceCurrency === 'USD' || !Number.isFinite(rates.toUsd) || rates.toUsd <= 0) {
    return `Transfers must be between $${MIN_USD} and $${MAX_USD}.`;
  }
  const minSrc = Math.ceil(MIN_USD / rates.toUsd);
  const maxSrc = Math.floor(MAX_USD / rates.toUsd);
  return `Transfers must be between ${fmtAmount(minSrc, sourceCurrency)} and ${fmtAmount(maxSrc, sourceCurrency)}.`;
}

export function quote(
  amountSource: number,
  sourceCurrency: CurrencyCode,
  rates: FxRates,
  fundingMethod: FundingMethod,
  transferCount: number,
  destinationCurrency: CurrencyCode = 'INR',  // NEW (any-to-any) — defaults to INR (back-compat)
  destToUsd?: number,                          // NEW — destination currency's USD rate (for the cross-rate via USD pivot)
): Quote {
  if (!Number.isFinite(amountSource)) {
    throw new QuoteError('Please give a valid amount.');
  }
  amountSource = round2(amountSource);
  const amountUsd = round2(amountSource * rates.toUsd);
  if (!Number.isFinite(amountUsd)) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  if (amountUsd < MIN_USD || amountUsd > MAX_USD) {
    throw new QuoteError(limitMessage(sourceCurrency, rates));
  }

  let feeUsd: number;
  if (transferCount === 0) {
    feeUsd = 0;
  } else {
    switch (fundingMethod) {
      case 'bank_transfer':
        feeUsd = 1.99;
        break;
      case 'ach_pull': // B2B ACH bank debit — flat, like a bank transfer
      case 'bank_pull': // cross-border B2B local bank debit — same flat B2B fee
        feeUsd = 1.99;
        break;
      case 'debit_card':
        feeUsd = 2.99;
        break;
      case 'credit_card':
        feeUsd = round2(2.99 + 0.03 * amountUsd);
        break;
      default:
        // Guards against an unexpected funding method (e.g. the LLM passing a
        // value outside the schema enum) producing NaN amounts.
        throw new QuoteError(
          'Please choose how to pay: credit card, debit card, or bank transfer.',
        );
    }
  }

  const feeSource = round2(feeUsd / rates.toUsd);

  // Source -> destination cross-rate. For an INR destination (or when no dest
  // rate is supplied) this is rates.toInr — byte-for-byte identical to the
  // pre-any-to-any behavior. Otherwise pivot through USD: src->dest = src.toUsd / dest.toUsd.
  const crossRate = usdPivotCrossRate(rates, destinationCurrency, destToUsd);
  // Guard: a non-finite or non-positive cross-rate would produce a negative/NaN
  // recipient amount. sourceForDest() already enforces this; quote() must too.
  if (!Number.isFinite(crossRate) || crossRate <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  const amountInr = Math.round(amountSource * crossRate); // amount in the destination currency

  return {
    amountUsd,
    feeUsd,
    totalChargeUsd: round2(amountUsd + feeUsd),
    fxRate: crossRate,
    amountInr,
    deliveryEstimate: 'within 10 minutes',
    sourceCurrency,
    amountSource,
    feeSource,
    totalChargeSource: round2(amountSource + feeSource),
    destinationCurrency,
  };
}

/**
 * The fee the sender WOULD pay on a repeat send with this funding method, in USD.
 * Single-sources the same fee schedule quote() uses (bank 1.99 / debit 2.99 /
 * credit 2.99 + 3%), so the "first transfer free — you save $X" framing can show
 * an honest figure without quote() (which returns 0 on a first transfer) supplying
 * it. quote()'s body is unchanged; this is a pure sibling for presentation only.
 */
export function wouldBeFeeUsd(amountUsd: number, fundingMethod: FundingMethod): number {
  switch (fundingMethod) {
    case 'bank_transfer':
    case 'ach_pull':
    case 'bank_pull':
      return 1.99;
    case 'debit_card':
      return 2.99;
    case 'credit_card':
      return round2(2.99 + 0.03 * amountUsd);
  }
}

/**
 * Back-solve the send amount (in the sender's source currency) from a target
 * amount the recipient should receive IN THE DESTINATION CURRENCY — the exact
 * inverse of the forward cross-rate in quote() (the USD-pivot crossRate). For an
 * INR destination (or no dest rate) this is `amountDest / rates.toInr`, byte-for-
 * byte the old sourceForInr; otherwise it inverts `src.toUsd / dest.toUsd`, so a
 * non-INR destination receive target (any-to-any, e.g. "they should get $500")
 * back-solves correctly on ANY source corridor. quote() then enforces
 * MIN_USD/MAX_USD on the USD-equivalent and adds the fee on top.
 */
export function sourceForDest(
  amountDest: number,
  rates: FxRates,
  destinationCurrency: CurrencyCode = 'INR',
  destToUsd?: number,
): number {
  if (!Number.isFinite(amountDest) || amountDest <= 0) {
    throw new QuoteError('Please give a valid amount.');
  }
  const crossRate = usdPivotCrossRate(rates, destinationCurrency, destToUsd);
  if (!Number.isFinite(crossRate) || crossRate <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  return round2(amountDest / crossRate);
}

/**
 * Back-compat wrapper: receive-first to an INR destination (the original
 * caller). Identical results to the pre-any-to-any implementation.
 */
export function sourceForInr(amountInr: number, rates: FxRates): number {
  if (!Number.isFinite(amountInr) || amountInr <= 0) {
    throw new QuoteError('Please give a valid rupee amount.');
  }
  return sourceForDest(amountInr, rates, 'INR', undefined);
}
