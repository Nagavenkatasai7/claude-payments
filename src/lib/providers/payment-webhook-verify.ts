import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an HMAC-SHA256 signature over the RAW request body. Real payment
 * providers present this; the mock skips verification (its handleWebhook is a
 * no-op). Fail-CLOSED: an empty secret or signature returns false, so an
 * unconfigured real provider is rejected rather than silently trusted.
 * Algorithm is fixed to sha256 for v1; a partner with a different scheme would
 * parameterize this once a real spec exists (spec open question 6).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const sig = signature ?? '';
  const key = secret ?? '';
  if (key === '' || sig === '') return false;            // fail-closed
  const expected = createHmac('sha256', key).update(rawBody ?? '').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;               // timingSafeEqual requires equal length
  return timingSafeEqual(a, b);
}
