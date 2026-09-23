/**
 * Program-Fix 7 — POST /api/funding-webhook/stripe/<partnerId>: the Stripe
 * funding webhook. Auth posture (all fail-closed, all the SAME 401 so the
 * route leaks nothing about which partners are configured):
 *  - per-IP rate limit first (like every webhook), before any DB read;
 *  - flag OFF ⇒ 401; unknown partner / no Stripe config / no endpoint secret ⇒ 401;
 *  - Stripe-Signature v1 over the RAW body with the partner's endpoint
 *    secret(s), 5-minute tolerance (https://docs.stripe.com/webhooks);
 *  - only provider 'stripe' is served here (else 404).
 * Network is never hit; the rate limiter is stubbed like the other webhook tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { freshDb, seedPartner } from './helpers-db';
import type { Transfer } from '@/lib/types';

let db: Awaited<ReturnType<typeof freshDb>>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
const limiter = vi.fn(async () => null as Response | null);
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: (...a: unknown[]) => limiter(...(a as [])) }));

import { POST } from '@/app/api/funding-webhook/[provider]/[partnerId]/route';

const WH = ['whsec', 'route', 'only'].join('_');
const KEY = ['sk', 'test', 'route', 'only'].join('_');
const now = () => Math.floor(Date.now() / 1000);
const sign = (raw: string, secret = WH, t = now()) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

function post(provider: string, partnerId: string, raw: string, signature?: string) {
  const req = new NextRequest(`https://x/api/funding-webhook/${provider}/${partnerId}`, {
    method: 'POST', body: raw, headers: signature ? { 'stripe-signature': signature } : {},
  });
  return POST(req, { params: Promise.resolve({ provider, partnerId }) });
}

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 195, feeUsd: 4.99, totalChargeUsd: 199.99, fxRate: 85,
    amountInr: 16575, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'acme',
    amountSource: 195, feeSource: 4.99, totalChargeSource: 199.99, ...o,
  };
}

const succeededBody = (id = 'w1', livemode = true) => JSON.stringify({
  id: `evt_${id}`, object: 'event', type: 'payment_intent.succeeded', livemode,
  data: { object: { id: `pi_${id}`, object: 'payment_intent', amount: 19999, amount_received: 19999, currency: 'usd', status: 'succeeded', metadata: { transfer_id: id, partner_id: 'acme' } } },
});

beforeEach(async () => {
  db = await freshDb();
  limiter.mockClear();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
  await createIntegrationsRepo(db).setFundingConfig('acme', { providerType: 'stripe', secretKey: KEY, webhookSecrets: [WH] });
  const repo = createTransferRepo(db);
  await repo.saveTransfer(makeTransfer({ id: 'w1' }));
  await repo.bindFundingIntent('w1', 'acme', 'stripe', 'pi_w1');
  process.env.STRIPE_FUNDING_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.STRIPE_FUNDING_ENABLED;
  delete process.env.STRIPE_FUNDING_ALLOW_TEST_MODE;
});

describe('POST /api/funding-webhook/stripe/[partnerId]', () => {
  it('a correctly signed success settles the transfer', async () => {
    const raw = succeededBody();
    const res = await post('stripe', 'acme', raw, sign(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect((await createTransferRepo(db).getTransfer('w1'))?.status).toBe('paid');
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  it('flag OFF ⇒ 401 even with a valid signature; nothing moves', async () => {
    delete process.env.STRIPE_FUNDING_ENABLED;
    const raw = succeededBody();
    expect((await post('stripe', 'acme', raw, sign(raw))).status).toBe(401);
    expect((await createTransferRepo(db).getTransfer('w1'))?.status).toBe('awaiting_payment');
  });

  it.each([
    ['no signature', undefined as string | undefined],
    ['wrong secret', 'other'],
    ['stale timestamp', 'stale'],
  ])('%s ⇒ 401, nothing moves', async (_l, mode) => {
    const raw = succeededBody();
    const sig = mode === undefined ? undefined : mode === 'other' ? sign(raw, ['whsec', 'other'].join('_')) : sign(raw, WH, now() - 3600);
    expect((await post('stripe', 'acme', raw, sig)).status).toBe(401);
    expect((await createTransferRepo(db).getTransfer('w1'))?.fundingState).toBe('pending');
  });

  it('a tampered body ⇒ 401', async () => {
    const raw = succeededBody();
    const sig = sign(raw);
    expect((await post('stripe', 'acme', raw.replace('19999,"amount_received":19999', '19999,"amount_received":1'), sig)).status).toBe(401);
  });

  it('a partner with no Stripe config, or an unknown partner, gets the SAME 401 (signed with another tenant\'s secret)', async () => {
    const raw = succeededBody();
    expect((await post('stripe', 'globex', raw, sign(raw))).status).toBe(401);
    expect((await post('stripe', 'nobody', raw, sign(raw))).status).toBe(401);
  });

  it('a malformed partner id ⇒ 401 before any DB read', async () => {
    const raw = succeededBody();
    expect((await post('stripe', '../../etc', raw, sign(raw))).status).toBe(401);
  });

  it('a non-stripe provider on this route ⇒ 404', async () => {
    const raw = succeededBody();
    expect((await post('mock', 'acme', raw, sign(raw))).status).toBe(404);
  });

  it('rate-limited ⇒ the limiter response, before verification', async () => {
    limiter.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    const raw = succeededBody();
    expect((await post('stripe', 'acme', raw, sign(raw))).status).toBe(429);
  });

  it('a replay of the same signed event is a 200 no-op (settled once)', async () => {
    const raw = succeededBody();
    await post('stripe', 'acme', raw, sign(raw));
    const res = await post('stripe', 'acme', raw, sign(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'duplicate' });
  });

  it('an irrelevant verified event type ⇒ 200 ignored', async () => {
    const raw = JSON.stringify({ id: 'evt_x', object: 'event', type: 'customer.created', livemode: true, data: { object: { id: 'cus_1' } } });
    const res = await post('stripe', 'acme', raw, sign(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
  });

  it('test-mode success is not settled unless STRIPE_FUNDING_ALLOW_TEST_MODE is true', async () => {
    const raw = succeededBody('w1', false);
    await post('stripe', 'acme', raw, sign(raw));
    expect((await createTransferRepo(db).getTransfer('w1'))?.status).toBe('awaiting_payment');
  });

  it('an oversized body ⇒ 413 without verification work', async () => {
    const raw = 'x'.repeat(300_000);
    expect((await post('stripe', 'acme', raw, sign(raw))).status).toBe(413);
  });
});
