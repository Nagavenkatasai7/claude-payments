// Review S2 (Program-Fix 32): the pay routes answer a POST on a row that is no
// longer awaiting payment with 200 { ok: true, status } (ruling 7 keeps that
// contract fixed — api/pay/[transferId]/route.ts refuseUnlessAwaiting). A
// CANCELLED row (an expired unpaid link, a staff cancel) must read as a dead
// link on the client, never "Payment complete". Pure, so it is unit-tested;
// the forms are UI and are not.

export type PayOkStatus = 'done' | 'inactive';

/** The client state for a 2xx pay response body (unparsable ⇒ done, as before). */
export function payOkStatus(body: unknown): PayOkStatus {
  if (body && typeof body === 'object' && (body as { status?: unknown }).status === 'cancelled') {
    return 'inactive';
  }
  return 'done';
}

// Program-Fix 14 follow-up: the two pay refusals the customer can fix in the
// WhatsApp chat get their own copy; every other failure keeps the form's
// generic text. Fixed client copy only — never the server's `error` string.
export const PAY_SENDER_NAME_REQUIRED_COPY =
  'We need your full legal name before this transfer can go ahead. Reply in the WhatsApp chat with your full legal name as on your ID, then open this link again.';
export const PAY_KYC_REQUIRED_COPY =
  'Please complete verification before sending. Reply in the WhatsApp chat to finish verifying, then open this link again.';
// Fix D: the route's 503 on an infrastructure error. It never claims nothing
// was charged: the route's outer catch also wraps post-capture code.
export const PAY_TEMPORARY_COPY =
  'We hit a temporary problem on our side. Please try again in a moment. If your code no longer works, tap Resend for a new one.';

// Step 0 FX-2: the pay route's rate refusals (api/pay/[transferId]/route.ts).
// otp-send-copy.ts duplicates the first three (it must stay import-free); a
// test pins them equal.
//   409 rate_expired                 — the row was cancelled; nothing was charged
//   409 rate_expired_payment_pending — a bank debit may be in flight: never "cancelled"
//   503 fx_unavailable               — retryable (FX_UNAVAILABLE_MESSAGE, rate.ts)
//   503 fx_unavailable + quoteExpired — the DRAFT's quote aged out; nothing minted (N9)
export const PAY_RATE_EXPIRED_COPY =
  'The exchange rate for this transfer has expired, so we cancelled it — nothing was charged. Reply in the WhatsApp chat to get a fresh quote.';
export const PAY_RATE_EXPIRED_PAYMENT_PENDING_COPY =
  "The exchange rate for this transfer has expired, so it can't be paid from this page. If you already approved a bank payment for it, that payment may still go through at the original rate and we'll message you on WhatsApp when it does. Otherwise, reply in the WhatsApp chat to get a fresh quote.";
export const PAY_FX_UNAVAILABLE_COPY =
  'Exchange rates are temporarily unavailable — please try again in a few minutes.';
export const PAY_QUOTE_EXPIRED_COPY = 'This quote has expired. Reply in the WhatsApp chat to get a fresh quote.';

/** The specific message for a non-2xx pay response body, or null ⇒ the generic one. */
export function payErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { reason?: unknown; kyc_required?: unknown; quoteExpired?: unknown };
  if (b.quoteExpired === true) return PAY_QUOTE_EXPIRED_COPY;
  if (b.reason === 'rate_expired') return PAY_RATE_EXPIRED_COPY;
  if (b.reason === 'rate_expired_payment_pending') return PAY_RATE_EXPIRED_PAYMENT_PENDING_COPY;
  if (b.reason === 'fx_unavailable') return PAY_FX_UNAVAILABLE_COPY;
  if (b.reason === 'sender_name_required') return PAY_SENDER_NAME_REQUIRED_COPY;
  if (b.kyc_required === true || b.reason === 'kyc_required') return PAY_KYC_REQUIRED_COPY;
  if (b.reason === 'temporarily_unavailable') return PAY_TEMPORARY_COPY;
  return null;
}
