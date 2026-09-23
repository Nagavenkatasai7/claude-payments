// funding-amount — Program-Fix 7: the ONE dollars → minor-units conversion.
//
// Stripe amounts are integers in the smallest currency unit, minimum $0.50,
// at most eight digits (https://docs.stripe.com/api/payment_intents/create.md,
// `amount`). The ledger stores money as numeric(12,2) (schema.ts), so every
// input here is already a 2-decimal value; Math.round of value*100 is exact
// for those (the float error of x*100 is far below 0.5). Truncation is the
// bug this module exists to prevent (0.29 * 100 = 28.999…).
//
// Used BOTH when creating a PaymentIntent (amount) and when cross-checking a
// verified webhook (amount_received) — one helper, so the two can never drift.

/** Stripe's documented minimum charge for USD (in cents). */
export const STRIPE_MIN_USD_CENTS = 50;
/** Stripe's documented ceiling: eight digits in the smallest unit. */
export const STRIPE_MAX_MINOR_UNITS = 99_999_999;

export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('funding amount must be a positive finite number');
  }
  const cents = Math.round(amount * 100);
  if (cents > STRIPE_MAX_MINOR_UNITS) {
    throw new Error('funding amount exceeds the processor ceiling');
  }
  return cents;
}
