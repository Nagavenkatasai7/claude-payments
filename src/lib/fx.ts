import type { PayoutMethod, Quote } from './types';

export const FX_RATE = 85.2;
export const REPEAT_FEE_USD = 2.99;
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
  payoutMethod: PayoutMethod,
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
  const feeUsd = transferCount === 0 ? 0 : REPEAT_FEE_USD;
  const amountInr = Math.round(amountUsd * FX_RATE);
  const totalChargeUsd = Math.round((amountUsd + feeUsd) * 100) / 100;
  const deliveryEstimate =
    payoutMethod === 'upi' ? 'within minutes' : 'within 2 hours';

  return {
    amountUsd,
    feeUsd,
    totalChargeUsd,
    fxRate: FX_RATE,
    amountInr,
    deliveryEstimate,
  };
}
