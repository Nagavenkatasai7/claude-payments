/**
 * Program-Fix 7 — the pay route with REAL async funds capture (Stripe, flag
 * ON). The money rules:
 *  - a Stripe capture is PENDING: the route binds the intent (never as
 *    fundingRef), returns `awaiting_funds` + the client secret for the
 *    browser, and NEVER settles, messages or flips status;
 *  - a re-POST re-presents the SAME intent (retrieve, never a second create);
 *  - a refused selection (default tenant, routed, unconfigured) is a 402 with
 *    nothing mutated and no processor call;
 *  - flag OFF keeps the exact legacy path (tests/pay-route-funding.test.ts is
 *    unchanged and still green).
 * The processor is never reached: fetch is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';

// Swallow after() (poke fast paths) — this suite is about capture ordering,
// not worker pokes. vi.hoisted so the box exists before the mock factory.
const captured = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  /** Interleaving record: 'capture' | 'sendText' | 'settle' in call order. */
  order: [] as string[],
}));
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return {
    ...real,
    after: (cb: () => unknown) => {
      captured.afterCallbacks.push(cb);
    },
  };
});

const sendText = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => {
    captured.order.push('sendText');
  }),
);
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

// OTP always passes; no draft (phone resolves from the existing transfer).
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: async () => ({ ok: true }),
  }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return { ...real, getCustomerStore: () => customerStore };
});

vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      requireKycBeforeSend: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));

// The partner's OWN Stripe funding config (Program-Fix 7) + the mock rail.
const fundingConfig = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }), // mock rail
    getFundingConfig: async () => fundingConfig.value,
  }),
}));

vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/pay/[transferId]/route';

const KEY = ['sk', 'test', 'payroute', 'only'].join('_');

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

function post(id: string) {
  const req = new NextRequest('http://localhost/api/pay/' + id, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ transferId: id }) });
}

const outboxCount = async () => {
  const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as { rows: Array<{ n: number }> };
  return rows.rows[0].n;
};

const pi = (id: string, o: Record<string, unknown> = {}) => ({
  id: `pi_${id}`, object: 'payment_intent', amount: 19999, currency: 'usd', status: 'requires_payment_method',
  client_secret: [`pi_${id}`, 'secret', 'x'].join('_'), metadata: { transfer_id: id, partner_id: 'acme' }, ...o,
});
const fetchMock = vi.fn();

beforeEach(async () => {
  db = await freshDb();
  await db.execute(sql`INSERT INTO partners (id, name, status, countries, kyc_mode)
    VALUES ('acme', 'acme', 'active', '["US"]'::jsonb, 'ours') ON CONFLICT (id) DO NOTHING`);
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  for (const partnerId of ['acme', 'default']) {
    await customerStore.saveCustomer({
      senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified', fullName: 'Test Sender',
      senderCountry: 'US', partnerId, optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
    });
  }
  captured.afterCallbacks.length = 0;
  sendText.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fundingConfig.value = { providerType: 'stripe', secretKey: KEY, webhookSecrets: ['w'] };
  process.env.STRIPE_FUNDING_ENABLED = 'true';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STRIPE_FUNDING_ENABLED;
});

describe('pay route — Stripe async capture (flag ON)', () => {
  it('pending capture: binds the intent, returns awaiting_funds + client secret, NEVER settles or messages', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pi('s1'))));
    await store.saveTransfer(makeTransfer({ id: 's1' }));
    const res = await post('s1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'awaiting_funds', clientSecret: ['pi_s1', 'secret', 'x'].join('_') });
    const t = await store.getTransfer('s1');
    expect(t).toMatchObject({ status: 'awaiting_payment', fundingState: 'pending', fundingIntentRef: 'pi_s1', fundingProvider: 'stripe' });
    expect(t?.fundingRef).toBeUndefined();
    expect(await outboxCount()).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(init.method).toBe('POST');
  });

  it('a re-POST retrieves the SAME intent (no second create) and still never settles', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pi('s2'))));
    await store.saveTransfer(makeTransfer({ id: 's2' }));
    await post('s2');
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pi('s2', { status: 'processing' }))));
    const again = await post('s2');
    expect(await again.json()).toMatchObject({ status: 'awaiting_funds' });
    const creates = fetchMock.mock.calls.filter(([, i]) => (i as RequestInit).method === 'POST');
    expect(creates).toHaveLength(1);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.stripe.com/v1/payment_intents/pi_s2');
    expect((await store.getTransfer('s2'))?.status).toBe('awaiting_payment');
  });

  it('a processor error is a clean 402 with nothing bound', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    await store.saveTransfer(makeTransfer({ id: 's3' }));
    const res = await post('s3');
    expect(res.status).toBe(402);
    const t = await store.getTransfer('s3');
    expect(t?.fundingIntentRef).toBeUndefined();
    expect(await outboxCount()).toBe(0);
  });

  it('SmartRemit\'s own default tenant with a Stripe config is REFUSED (402), no processor call, nothing mutated', async () => {
    await store.saveTransfer(makeTransfer({ id: 's4', partnerId: 'default' }));
    const res = await post('s4');
    expect(res.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await store.getTransfer('s4'))?.status).toBe('awaiting_payment');
  });

  it('a transfer whose debit already SUCCEEDED (settle crashed) settles on re-POST without a new capture', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pi('s5'))));
    await store.saveTransfer(makeTransfer({ id: 's5' }));
    await post('s5');
    await db.execute(sql`UPDATE transfers SET funding_state = 'succeeded', funding_ref = 'pi_s5' WHERE id = 's5'`);
    fetchMock.mockClear();
    const res = await post('s5');
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a RETURNED debit is refused (402) and never settles', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(pi('s6'))));
    await store.saveTransfer(makeTransfer({ id: 's6' }));
    await post('s6');
    await db.execute(sql`UPDATE transfers SET funding_state = 'returned' WHERE id = 's6'`);
    const res = await post('s6');
    expect(res.status).toBe(402);
    expect((await store.getTransfer('s6'))?.status).toBe('awaiting_payment');
    expect(await outboxCount()).toBe(0);
  });

  it('flag OFF: the partner\'s Stripe config is ignored — legacy mock capture + settle, no processor call', async () => {
    delete process.env.STRIPE_FUNDING_ENABLED;
    await store.saveTransfer(makeTransfer({ id: 's7' }));
    const res = await post('s7');
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('stripe.com'))).toHaveLength(0);
    expect((await store.getTransfer('s7'))?.fundingRef).toBe('mockfund-s7');
  });
});
