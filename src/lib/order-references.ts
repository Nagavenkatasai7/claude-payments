// order-references — Batch B1. The pure checks for a transfer's two references:
//
//  • client_reference: the partner's own order number, sent on POST /transactions.
//    Up to 64 letters, digits and `. _ : / # -`. A present but bad value is a 400
//    BEFORE anything is saved (partner-api-service.createTransaction). Payment
//    links (B2) reuse isValidClientReference for the link's reference.
//  • payout_reference: the payout partner's confirmation (for example a bank UTR),
//    read from a SIGNED status callback. A bad value is ignored (never an error):
//    the callback's status still applies.
//
// The charset has no space, quote, comma, `=`/`+`/`@` or control character, so a
// reference is safe in a CSV cell, a log line and an HTML attribute as it is.

export const CLIENT_REFERENCE_MAX = 64;
export const PAYOUT_REFERENCE_MAX = 64;

const REFERENCE_RE = /^[A-Za-z0-9._:/#-]+$/;

export const CLIENT_REFERENCE_ERROR =
  `client_reference must be 1–${CLIENT_REFERENCE_MAX} characters: letters, digits and . _ : / # -`;

/** True for a string of 1–64 characters from the reference charset. */
export function isValidClientReference(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= CLIENT_REFERENCE_MAX && REFERENCE_RE.test(v);
}

/** Absent (undefined / null) ⇒ no value. Present ⇒ it must be valid exactly as sent (no trimming). */
export function parseClientReference(v: unknown): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  return isValidClientReference(v) ? { ok: true, value: v } : { ok: false, error: CLIENT_REFERENCE_ERROR };
}

/** A callback's payout reference, trimmed; null when absent or not a valid reference. */
export function parsePayoutReference(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= PAYOUT_REFERENCE_MAX && REFERENCE_RE.test(s) ? s : null;
}

/** The reference rail's simulated payout confirmation (testing mode shows it after delivery). */
export function simulatorPayoutReference(reference: string): string {
  return `SIMPAY-${reference}`;
}
