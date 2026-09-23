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

/** The specific message for a non-2xx pay response body, or null ⇒ the generic one. */
export function payErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { reason?: unknown; kyc_required?: unknown };
  if (b.reason === 'sender_name_required') return PAY_SENDER_NAME_REQUIRED_COPY;
  if (b.kyc_required === true || b.reason === 'kyc_required') return PAY_KYC_REQUIRED_COPY;
  return null;
}
