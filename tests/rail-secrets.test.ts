import { describe, it, expect, afterEach } from 'vitest';
import { railSecrets, withRotatedSecret, pruneExpiredPrevious } from '@/lib/partner-integrations';
import { env } from '@/lib/env';

// Program-Fix 29: key rotation with no migration. The current webhook secret
// lives in its own column (payment.webhookSecret); the current signing secret
// and BOTH previous secrets live in the encrypted credentials blob, each
// previous with its own expiry.

const NOW = new Date('2026-09-23T12:00:00Z');
const FUTURE = '2026-09-30T12:00:00.000Z';
const PAST = '2026-09-20T12:00:00.000Z';

describe('railSecrets', () => {
  it('webhook: current from the column first, then an unexpired previous from the blob', () => {
    expect(railSecrets({
      webhookSecret: 'whk_new',
      credentials: { previousWebhookSecret: 'whk_old', previousWebhookSecretUntil: FUTURE },
    }, 'webhook', NOW)).toEqual(['whk_new', 'whk_old']);
  });

  it('signing: both from the blob', () => {
    expect(railSecrets({
      credentials: { signingSecret: 'sg_new', previousSigningSecret: 'sg_old', previousSigningSecretUntil: FUTURE },
    }, 'signing', NOW)).toEqual(['sg_new', 'sg_old']);
  });

  it('an expired, missing-expiry or unparseable-expiry previous is ignored', () => {
    const base = { signingSecret: 'sg_new', previousSigningSecret: 'sg_old' };
    expect(railSecrets({ credentials: { ...base, previousSigningSecretUntil: PAST } }, 'signing', NOW)).toEqual(['sg_new']);
    expect(railSecrets({ credentials: base }, 'signing', NOW)).toEqual(['sg_new']);
    expect(railSecrets({ credentials: { ...base, previousSigningSecretUntil: 'nope' } }, 'signing', NOW)).toEqual(['sg_new']);
  });

  it('the kinds never mix: a previous signing secret is not a webhook secret', () => {
    expect(railSecrets({
      webhookSecret: 'whk',
      credentials: { previousSigningSecret: 'sg_old', previousSigningSecretUntil: FUTURE },
    }, 'webhook', NOW)).toEqual(['whk']);
  });

  it('no current secret → [] (the previous alone never signs or verifies)', () => {
    expect(railSecrets({ credentials: { previousWebhookSecret: 'old', previousWebhookSecretUntil: FUTURE } }, 'webhook', NOW)).toEqual([]);
    expect(railSecrets(undefined, 'signing', NOW)).toEqual([]);
    expect(railSecrets({}, 'signing', NOW)).toEqual([]);
  });

  it('a previous equal to the current is not listed twice', () => {
    expect(railSecrets({ webhookSecret: 'same', credentials: { previousWebhookSecret: 'same', previousWebhookSecretUntil: FUTURE } }, 'webhook', NOW))
      .toEqual(['same']);
  });
});

describe('env.paymentWebhookSecretPrevious', () => {
  afterEach(() => { delete process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER_PREVIOUS; });
  it("'' when unset; the value when set", () => {
    expect(env.paymentWebhookSecretPrevious('uniteller')).toBe('');
    process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER_PREVIOUS = 'old';
    expect(env.paymentWebhookSecretPrevious('uniteller')).toBe('old');
  });
});

describe('withRotatedSecret / pruneExpiredPrevious', () => {
  it('a changed secret records the old one with now + 7 days; the input is not mutated', () => {
    const creds = { signingSecret: 'a' };
    const out = withRotatedSecret(creds, 'signing', 'a', 'b', NOW);
    expect(out).toEqual({ signingSecret: 'a', previousSigningSecret: 'a', previousSigningSecretUntil: '2026-09-30T12:00:00.000Z' });
    expect(creds).toEqual({ signingSecret: 'a' });
  });
  it('no old value, no new value, or the same value → no rotation', () => {
    expect(withRotatedSecret({}, 'webhook', undefined, 'b', NOW)).toEqual({});
    expect(withRotatedSecret({}, 'webhook', 'a', undefined, NOW)).toEqual({});
    expect(withRotatedSecret({}, 'webhook', 'a', 'a', NOW)).toEqual({});
  });
  it('prunes expired, unparseable or empty previous pairs and keeps live ones', () => {
    expect(pruneExpiredPrevious({
      x: '1',
      previousWebhookSecret: 'w', previousWebhookSecretUntil: PAST,
      previousSigningSecret: 's', previousSigningSecretUntil: FUTURE,
    }, NOW)).toEqual({ x: '1', previousSigningSecret: 's', previousSigningSecretUntil: FUTURE });
    expect(pruneExpiredPrevious({ previousWebhookSecret: 'w', previousWebhookSecretUntil: 'bad' }, NOW)).toEqual({});
    expect(pruneExpiredPrevious({ previousWebhookSecretUntil: FUTURE }, NOW)).toEqual({});
  });
});
