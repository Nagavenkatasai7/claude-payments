import { createHmac, timingSafeEqual } from 'node:crypto';

// stripe-signature — Program-Fix 7: verify a Stripe webhook WITHOUT the
// `stripe` package (no new dependency), following Stripe's documented manual
// scheme (https://docs.stripe.com/webhooks, "Verify webhook signatures
// manually"):
//   1. `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]` — split on ','
//      then on '='; keep `t` and every `v1`; DISCARD every other scheme (v0 is
//      a fake test-mode scheme; ignoring it prevents a downgrade attack).
//   2. signed_payload = `${t}.${rawBody}` (the raw body, byte-for-byte).
//   3. expected = HMAC-SHA256(endpoint signing secret, signed_payload), hex.
//   4. constant-time compare against each v1; then the timestamp must be
//      within the tolerance (the libraries default to 5 minutes).
// Several v1 values appear while an endpoint secret is being rolled, and a
// partner may hold two active secrets during that window — any (v1, secret)
// match verifies. FAIL-CLOSED on everything else: malformed header, no v1, no
// secret, empty secret, out-of-window timestamp.

/** The documented library default: 5 minutes. Never 0 (0 disables the check). */
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

const HEX64 = /^[0-9a-f]{64}$/;

export function verifyStripeSignature(
  rawBody: string,
  header: string,
  secrets: readonly string[],
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = STRIPE_SIGNATURE_TOLERANCE_SEC,
): boolean {
  const usable = secrets.filter((s) => typeof s === 'string' && s !== '');
  if (usable.length === 0 || typeof header !== 'string' || header === '') return false;

  let timestamp: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1' && HEX64.test(value)) v1.push(value);
  }
  if (timestamp === null || !/^\d{1,12}$/.test(timestamp) || v1.length === 0) return false;
  const t = Number(timestamp);
  if (Math.abs(nowSec - t) > toleranceSec) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  let ok = false;
  for (const secret of usable) {
    const expected = Buffer.from(createHmac('sha256', secret).update(signedPayload).digest('hex'), 'utf8');
    for (const candidate of v1) {
      const got = Buffer.from(candidate, 'utf8');
      // Both are 64 hex chars (HEX64 above), so the length check never
      // short-circuits on attacker-controlled input; keep it for safety.
      if (got.length === expected.length && timingSafeEqual(got, expected)) ok = true;
    }
  }
  return ok;
}
