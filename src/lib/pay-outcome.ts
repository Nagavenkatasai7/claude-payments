import { REWARD_ENDED_MESSAGE } from './rewards/copy';
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
/** B3 rewards v1: the reward on this quote ended before payment; nothing was charged. */
export const PAY_REWARD_ENDED_COPY = REWARD_ENDED_MESSAGE;

// Fix pack 4 (C10, C8, C18): the server sends the same strings as `error`.
//   409 reload_required        — the page the customer approved is out of date
//   503 approval_not_recorded  — the evidence commit failed before any capture
// PAY_ACCOUNT_HOLDER_COPY is a field error (fieldErrors.accountHolder), never
// a payErrorMessage answer.
export const PAY_RELOAD_REQUIRED_COPY =
  'This page is out of date. Reload the page, check the details, then try again. Nothing was charged.';
export const PAY_APPROVAL_NOT_RECORDED_COPY =
  "We couldn't record your approval, so nothing was charged. Tap Resend for a new code, then try again.";
// Review R1-P1 A1: the same two answers on a row that is already funded (a
// recorded capture, or a bank debit bound or settled; the body carries
// `funded: true`). They drop the "nothing was charged" clause, as
// PAY_TEMPORARY_COPY does.
export const PAY_RELOAD_REQUIRED_FUNDED_COPY =
  'This page is out of date. Reload the page, check the details, then try again.';
export const PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY =
  "We couldn't record your approval. Tap Resend for a new code, then try again.";
// Review R2-Q1 I2: 409 not_available (PAY_NOT_AVAILABLE, pay-not-available.ts) on the pay POST.
// Duplicates fixedReply('cannot_complete') (hold-replies.ts) so this module stays import-light;
// a test pins them equal.
export const PAY_NOT_AVAILABLE_COPY = "This transfer can't be completed right now.";
export const PAY_ACCOUNT_HOLDER_COPY = "Enter the account holder's name as it appears at the recipient's bank.";

/** The specific message for a non-2xx pay response body, or null ⇒ the generic one. */
export function payErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { reason?: unknown; kyc_required?: unknown; quoteExpired?: unknown; funded?: unknown };
  if (b.quoteExpired === true) return PAY_QUOTE_EXPIRED_COPY;
  if (b.reason === 'rate_expired') return PAY_RATE_EXPIRED_COPY;
  if (b.reason === 'rate_expired_payment_pending') return PAY_RATE_EXPIRED_PAYMENT_PENDING_COPY;
  if (b.reason === 'fx_unavailable') return PAY_FX_UNAVAILABLE_COPY;
  if (b.reason === 'sender_name_required') return PAY_SENDER_NAME_REQUIRED_COPY;
  if (b.kyc_required === true || b.reason === 'kyc_required') return PAY_KYC_REQUIRED_COPY;
  if (b.reason === 'temporarily_unavailable') return PAY_TEMPORARY_COPY;
  if (b.reason === 'reward_ended') return PAY_REWARD_ENDED_COPY;
  if (b.reason === 'reload_required') return b.funded === true ? PAY_RELOAD_REQUIRED_FUNDED_COPY : PAY_RELOAD_REQUIRED_COPY;
  if (b.reason === 'not_available') return PAY_NOT_AVAILABLE_COPY;
  if (b.reason === 'approval_not_recorded') {
    return b.funded === true ? PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY : PAY_APPROVAL_NOT_RECORDED_COPY;
  }
  return null;
}

// Review R3-Y2 R1: the B2B bill form's answer to a parsed non-OK body that is not quote_expired,
// otp or fieldErrors (the form's own branches). Each of these three comes after the code was
// verified (or may have been spent), so the form clears it: the copy says to tap Resend or that
// the transfer cannot go ahead. Anything else is null and the form keeps its generic fallback.
export type BillPayErrorOutcome = { message: string | null; clearCode: boolean };

export function billPayErrorOutcome(body: unknown): BillPayErrorOutcome {
  if (!body || typeof body !== 'object') return { message: null, clearCode: false };
  const reason = (body as { reason?: unknown }).reason;
  if (reason === 'temporarily_unavailable' || reason === 'not_available' || reason === 'approval_not_recorded') {
    return { message: payErrorMessage(body), clearCode: true };
  }
  return { message: null, clearCode: false };
}

// Fix pack 4 (C14, C10): the acknowledgement fields a pay form posts. The
// version only when the box is ticked; the hash of the block the page was
// rendered with only when it is a dh1 hash (optional for one release: the
// server ignores an absent one). Client-safe.
const DISCLOSURE_HASH_RE = /^dh1:[0-9a-f]{64}$/;

export function disclosureAckBody(
  version: string | null,
  hash: string | null,
  acked: boolean,
): { disclosureVersion?: string; disclosureHash?: string } {
  if (!acked || version === null) return {};
  return hash !== null && DISCLOSURE_HASH_RE.test(hash) ? { disclosureVersion: version, disclosureHash: hash } : { disclosureVersion: version };
}
