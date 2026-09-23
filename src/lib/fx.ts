import type { CurrencyCode, FundingMethod, Quote } from './types';
import { FX_MAX_AGE_MS, RateUnavailableError, type FxRates } from './rate';
import { SEND_LIMIT_HARD_CEILING_CENTS } from './send-limits';

export const MIN_USD = 10;
export const MAX_USD = 2999; // pinned to PLATFORM_SEND_LIMITS.maxUsd (send-limits.ts) — ruling 12: this line only

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
 * For an INR destination, or when NO destination USD rate is supplied
 * (null/undefined — the INR-only callers), this is the source→INR rate
 * (rates.toInr); otherwise it pivots through USD: src->dest = src.toUsd / dest.toUsd.
 *
 * prs-04: a SUPPLIED destToUsd must be finite and > 0. The old `!destToUsd` test
 * let a 0 fall into the INR branch, so quote(100,'USD',…,'AED',0) returned
 * fxRate 85 / amountInr 8500 labelled AED — now a QuoteError.
 */
export function usdPivotCrossRate(
  rates: FxRates,
  destinationCurrency: CurrencyCode = 'INR',
  destToUsd?: number,
): number {
  if (destinationCurrency === 'INR' || destToUsd == null) return rates.toInr;
  if (!Number.isFinite(destToUsd) || destToUsd <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  return rates.toUsd / destToUsd;
}

/**
 * The provenance gate (money-07). A quoted rate becomes a BINDING payout
 * instruction, so nothing from the static display table and nothing older than
 * FX_MAX_AGE_MS may price a transfer. getFxRates ALWAYS stamps real rates;
 * provenance-less literals (tests, injected fakes) pass.
 */
export function assertRatesUsable(rates: FxRates, now: number = Date.now()): void {
  if (rates.source === 'fallback') throw new RateUnavailableError('fallback_table');
  if (rates.fetchedAt !== undefined && now - rates.fetchedAt > FX_MAX_AGE_MS) {
    throw new RateUnavailableError('stale');
  }
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
function limitMessage(sourceCurrency: CurrencyCode, rates: FxRates, maxUsd: number = MAX_USD): string {
  if (sourceCurrency === 'USD' || !Number.isFinite(rates.toUsd) || rates.toUsd <= 0) {
    return `Transfers must be between $${MIN_USD} and $${maxUsd}.`;
  }
  const minSrc = Math.ceil(MIN_USD / rates.toUsd);
  const maxSrc = Math.floor(maxUsd / rates.toUsd);
  return `Transfers must be between ${fmtAmount(minSrc, sourceCurrency)} and ${fmtAmount(maxSrc, sourceCurrency)}.`;
}

/**
 * Program fix 16b (ruling 12, amended): the per-sender quote ceiling. A caller
 * that knows the sender passes its resolved `limits.maxUsd`; it is ALWAYS
 * clamped to the hard ceiling ($10,000), and anything non-finite / <= 0 falls
 * back to the platform MAX_USD, so the default path is byte-for-byte unchanged.
 */
function effectiveMaxUsd(maxUsd: number | undefined): number {
  if (maxUsd === undefined || !Number.isFinite(maxUsd) || maxUsd <= 0) return MAX_USD;
  return Math.min(maxUsd, SEND_LIMIT_HARD_CEILING_CENTS / 100);
}

export function quote(
  amountSource: number,
  sourceCurrency: CurrencyCode,
  rates: FxRates,
  fundingMethod: FundingMethod,
  transferCount: number,
  destinationCurrency: CurrencyCode = 'INR',  // NEW (any-to-any) — defaults to INR (back-compat)
  destToUsd?: number,                          // NEW — destination currency's USD rate (for the cross-rate via USD pivot)
  maxUsd: number = MAX_USD,                    // fix 16b — the sender's effective quote ceiling (<= $10,000; default = platform)
): Quote {
  assertRatesUsable(rates);
  if (!Number.isFinite(amountSource)) {
    throw new QuoteError('Please give a valid amount.');
  }
  amountSource = round2(amountSource);
  const amountUsd = round2(amountSource * rates.toUsd);
  if (!Number.isFinite(amountUsd)) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  const ceilingUsd = effectiveMaxUsd(maxUsd);
  if (amountUsd < MIN_USD || amountUsd > ceilingUsd) {
    throw new QuoteError(limitMessage(sourceCurrency, rates, ceilingUsd));
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
  // Program-Fix 48: a finite-but-huge cross-rate (e.g. destToUsd ≈ 1e-306) can
  // overflow the recipient amount to Infinity. Never quote a non-finite payout.
  if (!Number.isFinite(amountInr)) {
    throw new QuoteError('Amount too large; please try again.');
  }

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
  assertRatesUsable(rates);
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
