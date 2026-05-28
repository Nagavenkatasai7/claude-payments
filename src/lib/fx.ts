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
): Quote {
  if (!Number.isFinite(amountSource)) {
    throw new QuoteError('Please give a valid amount.');
  }
  const amountUsd = round2(amountSource * rates.toUsd);
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
        throw new QuoteError(
          'Please choose how to pay: credit card, debit card, or bank transfer.',
        );
    }
  }

  feeUsd = round2(feeUsd);
  const feeSource = round2(feeUsd / rates.toUsd);
  const amountInr = Math.round(amountSource * rates.toInr);

  return {
    amountUsd,
    feeUsd,
    totalChargeUsd: round2(amountUsd + feeUsd),
    fxRate: rates.toInr,
    amountInr,
    deliveryEstimate: 'within 10 minutes',
    sourceCurrency,
    amountSource,
    feeSource,
    totalChargeSource: round2(amountSource + feeSource),
  };
}
