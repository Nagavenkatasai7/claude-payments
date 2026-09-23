// Program-Fix 25 PR B (§3.6): what the pay, bill-pay and seller-onboarding
// forms show when a confirmation-code request is refused. PURE (no imports), so
// client components and tests share one mapping. The route answers are:
//   502 { reason: 'otp_send_failed' } — the WhatsApp send failed (cooldown released)
//   429 { reason: 'locked' }          — an issue cap was reached
//   anything else (a limiter 429 with no reason, a 5xx) — a generic retry line.

export const OTP_SEND_FAILED_MESSAGE =
  "We couldn't send the code to WhatsApp. Message us on WhatsApp first, then tap Resend.";
export const OTP_LOCKED_MESSAGE = 'Too many codes were requested for this payment. Please try again later.';
export const OTP_RETRY_MESSAGE = "We couldn't send the code just now. Please try again in a moment.";

export function otpRequestErrorMessage(reason: unknown): string {
  if (reason === 'otp_send_failed') return OTP_SEND_FAILED_MESSAGE;
  if (reason === 'locked') return OTP_LOCKED_MESSAGE;
  return OTP_RETRY_MESSAGE;
}
