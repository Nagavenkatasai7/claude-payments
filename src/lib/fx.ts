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
    throw new QuoteError(`Transfers must be between $${MIN_USD} and $${MAX_USD}.`);
  }

  let feeUsd: number;
  if (transferCount === 0) {
    feeUsd = 0;
  } else {
    switch (fundingMethod) {
      case 'bank_transfer':
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
  const crossRate =
    destinationCurrency === 'INR' || !destToUsd || !Number.isFinite(destToUsd)
      ? rates.toInr
      : rates.toUsd / destToUsd;
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
      return 1.99;
    case 'debit_card':
      return 2.99;
    case 'credit_card':
      return round2(2.99 + 0.03 * amountUsd);
  }
}

/**
 * Back-solve the send amount (in the sender's source currency) from a target
 * rupee amount the recipient should receive — the exact inverse of the forward
 * line `amountInr = Math.round(amountSource * rates.toInr)` in quote(). The
 * caller feeds the result straight into quote(), which enforces MIN_USD/MAX_USD
 * on the USD-equivalent and adds the fee on TOP (the recipient still gets the
 * exact target INR). Receive-first quoting (Win A) is the only caller.
 */
export function sourceForInr(amountInr: number, rates: FxRates): number {
  if (!Number.isFinite(amountInr) || amountInr <= 0) {
    throw new QuoteError('Please give a valid rupee amount.');
  }
  if (!Number.isFinite(rates.toInr) || rates.toInr <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  return round2(amountInr / rates.toInr);
}
