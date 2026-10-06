// Program-Fix 25 PR B (§3.6): what the pay, bill-pay and seller-onboarding
// forms show when a confirmation-code request is refused. PURE (no imports), so
// client components and tests share one mapping. The route answers are:
//   502 { reason: 'otp_send_failed' } — the WhatsApp send failed (cooldown released)
//   429 { reason: 'locked' }          — an issue cap was reached
//   409 / 503 rate reasons (Step 0)   — the transfer's rate, see below
//   anything else (a limiter 429 with no reason, a 5xx) — a generic retry line.

export const OTP_SEND_FAILED_MESSAGE =
  "We couldn't send the code to WhatsApp. Message us on WhatsApp first, then tap Resend.";
export const OTP_LOCKED_MESSAGE = 'Too many codes were requested for this payment. Please try again later.';
export const OTP_RETRY_MESSAGE = "We couldn't send the code just now. Please try again in a moment.";
// Step 0 FX-2: the pay route refuses a stale rate BEFORE issuing a code
// (409 rate_expired / rate_expired_payment_pending, 503 fx_unavailable). These
// duplicate pay-outcome.ts's copy (this file stays import-free); a test pins
// them equal.
export const OTP_RATE_EXPIRED_MESSAGE =
  'The exchange rate for this transfer has expired, so we cancelled it — nothing was charged. Reply in the WhatsApp chat to get a fresh quote.';
export const OTP_RATE_EXPIRED_PAYMENT_PENDING_MESSAGE =
  "The exchange rate for this transfer has expired, so it can't be paid from this page. If you already approved a bank payment for it, that payment may still go through at the original rate and we'll message you on WhatsApp when it does. Otherwise, reply in the WhatsApp chat to get a fresh quote.";
export const OTP_FX_UNAVAILABLE_MESSAGE =
  'Exchange rates are temporarily unavailable — please try again in a few minutes.';

export function otpRequestErrorMessage(reason: unknown): string {
  if (reason === 'otp_send_failed') return OTP_SEND_FAILED_MESSAGE;
  if (reason === 'locked') return OTP_LOCKED_MESSAGE;
  if (reason === 'rate_expired') return OTP_RATE_EXPIRED_MESSAGE;
  if (reason === 'rate_expired_payment_pending') return OTP_RATE_EXPIRED_PAYMENT_PENDING_MESSAGE;
  if (reason === 'fx_unavailable') return OTP_FX_UNAVAILABLE_MESSAGE;
  return OTP_RETRY_MESSAGE;
}
