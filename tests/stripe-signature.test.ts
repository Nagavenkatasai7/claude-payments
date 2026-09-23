/**
 * Program-Fix 7 — Stripe webhook signature verification (manual scheme).
 *
 * Source: https://docs.stripe.com/webhooks (section "Verify webhook signatures
 * manually"): header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>][,v0=<hex>]`;
 * signed_payload = `${t}.${rawBody}`; expected = HMAC-SHA256(endpoint secret,
 * signed_payload) as hex; ONLY the v1 scheme counts (v0 is a fake test-mode
 * scheme — ignore it to prevent downgrade); several v1 values appear while a
 * secret is being rolled; constant-time compare; the libraries' default
 * tolerance is 5 minutes. Stripe publishes no secret+vector pair, so these
 * vectors are CONSTRUCTED from the documented algorithm with node:crypto.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyStripeSignature,
  STRIPE_SIGNATURE_TOLERANCE_SEC,
} from '@/lib/providers/stripe-signature';

// Built at runtime so no secret-shaped literal lands in the repo.
const SECRET = ['whsec', 'unit', 'test', 'secret'].join('_');
const OTHER = ['whsec', 'rolled', 'secret'].join('_');
const BODY = '{"id":"evt_1","object":"event","type":"payment_intent.succeeded"}';
const NOW = 1_790_000_000;

const v1 = (t: number, body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

describe('verifyStripeSignature', () => {
  it('accepts a correctly signed v1 payload inside the tolerance', () => {
    const header = `t=${NOW},v1=${v1(NOW, BODY)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(true);
  });

  it('accepts when ANY of several v1 signatures matches (secret roll)', () => {
    const header = `t=${NOW},v1=${v1(NOW, BODY, OTHER)},v1=${v1(NOW, BODY)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(true);
  });

  it('accepts when the payload is signed with ANY of the configured secrets', () => {
    const header = `t=${NOW},v1=${v1(NOW, BODY, OTHER)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET, OTHER], NOW)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = `t=${NOW},v1=${v1(NOW, BODY)}`;
    expect(verifyStripeSignature(BODY.replace('succeeded', 'failedxx'), header, [SECRET], NOW)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const header = `t=${NOW},v1=${v1(NOW, BODY, OTHER)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(false);
  });

  it('ignores v0 (downgrade): a valid v0 alone never verifies', () => {
    const header = `t=${NOW},v0=${v1(NOW, BODY)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(false);
  });

  it('rejects a timestamp older than the tolerance (replay)', () => {
    const t = NOW - STRIPE_SIGNATURE_TOLERANCE_SEC - 1;
    const header = `t=${t},v1=${v1(t, BODY)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(false);
  });

  it('rejects a timestamp too far in the future', () => {
    const t = NOW + STRIPE_SIGNATURE_TOLERANCE_SEC + 1;
    const header = `t=${t},v1=${v1(t, BODY)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(false);
  });

  it('accepts at exactly the tolerance edge', () => {
    const t = NOW - STRIPE_SIGNATURE_TOLERANCE_SEC;
    const header = `t=${t},v1=${v1(t, BODY)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(true);
  });

  it('the tolerance is the documented 5 minutes', () => {
    expect(STRIPE_SIGNATURE_TOLERANCE_SEC).toBe(300);
  });

  it.each([
    ['empty header', ''],
    ['no timestamp', `v1=${v1(NOW, BODY)}`],
    ['no v1', `t=${NOW}`],
    ['non-numeric timestamp', `t=abc,v1=${v1(NOW, BODY)}`],
    ['short hex', `t=${NOW},v1=abcd`],
    ['non-hex v1', `t=${NOW},v1=${'z'.repeat(64)}`],
    ['garbage', 'not a header at all'],
  ])('fails closed on a malformed header: %s', (_label, header) => {
    expect(verifyStripeSignature(BODY, header, [SECRET], NOW)).toBe(false);
  });

  it('fails closed with no secret configured (empty list or empty strings)', () => {
    const header = `t=${NOW},v1=${v1(NOW, BODY, '')}`;
    expect(verifyStripeSignature(BODY, header, [], NOW)).toBe(false);
    expect(verifyStripeSignature(BODY, header, [''], NOW)).toBe(false);
  });
});
