import { verifyWebhookSignature } from './payment-webhook-verify';

/**
 * Verify Meta's X-Hub-Signature-256 over the RAW request body.
 *
 * Header format: "sha256=<hex hmac-sha256 of the raw body, keyed by the App
 * Secret>". Meta signs the exact bytes it sent, so callers MUST pass the raw
 * request text (not a re-serialized parsed object).
 *
 * Fail-CLOSED: a missing/empty secret OR header, or a header without the
 * "sha256=" prefix, returns false. (The decision to PROCEED when the secret is
 * UNSET lives in the route, not here — here, no usable input ⇒ false.)
 *
 * Delegates the timing-safe, length-guarded hex comparison to
 * verifyWebhookSignature rather than re-implementing the crypto.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string,
  appSecret: string,
): boolean {
  const header = signatureHeader ?? '';
  if (appSecret === '' || header === '') return false; // fail-closed
  const prefix = 'sha256=';
  if (!header.startsWith(prefix)) return false; // wrong/unknown scheme
  const hex = header.slice(prefix.length);
  return verifyWebhookSignature(rawBody, hex, appSecret);
}
