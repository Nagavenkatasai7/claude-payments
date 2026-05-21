import type { FundingMethod, Quote } from './types';

export const MIN_USD = 10;
export const MAX_USD = 2999;

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteError';
  }
}

export function quote(
  amountUsd: number,
  fxRate: number,
  fundingMethod: FundingMethod,
  transferCount: number,
): Quote {
  if (!Number.isFinite(amountUsd)) {
    throw new QuoteError('Please give a valid amount in US dollars.');
  }
  if (amountUsd < MIN_USD || amountUsd > MAX_USD) {
    throw new QuoteError(
      `Transfers must be between $${MIN_USD} and $${MAX_USD}.`,
    );
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
        feeUsd = Math.round((2.99 + 0.03 * amountUsd) * 100) / 100;
        break;
    }
  }

  feeUsd = Math.round(feeUsd * 100) / 100;
  const amountInr = Math.round(amountUsd * fxRate);
  const totalChargeUsd = Math.round((amountUsd + feeUsd) * 100) / 100;
  const deliveryEstimate = 'within 10 minutes';

  return {
    amountUsd,
    feeUsd,
    totalChargeUsd,
    fxRate,
    amountInr,
    deliveryEstimate,
  };
}
