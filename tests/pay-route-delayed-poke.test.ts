/**
 * U8 audit fix: after a cleared MOCK-rail payment, the delivered confirmation
 * is a DELAYED outbox row (DELIVERY_DELAY_MS) — the route's immediate
 * pokeWorker() drains only READY rows, so without a second nudge the message
 * waits for the 5-minute heartbeat. The route must schedule a best-effort
 * DELAYED poke (DELIVERY_DELAY_MS + 10s) for started, non-webhook-driven
 * settlements — and must NOT schedule it for webhook-driven rails or on the
 * 'already' replay branch. The poke is pure fast path: a failing fetch is
 * swallowed (the heartbeat stays the delivery guarantee).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { DELIVERY_DELAY_MS } from '@/lib/providers/payment-provider';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';

// Unlike pay-route-bank-details (which no-ops after()), CAPTURE the
// post-response callbacks so each test can drive them deterministically with
// fake timers. vi.hoisted so the box exists before the hoisted mock factory.
const captured = vi.hoisted(() => ({ afterCallbacks: [] as Array<() => unknown> }));
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return {
    ...real,
    after: (cb: () => unknown) => {
      captured.afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

// OTP always passes; no draft (phone resolves from the existing transfer) —
// this suite exercises the poke scheduling, not the OTP gate.
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

// Switchable PER TEST: {} ⇒ mock rail (delayed mock.settle row);
// providerType 'simulator' ⇒ webhook-driven (no delayed poke expected).
let integrations: {
  kyc: Record<string, unknown>;
  payment: { providerType?: string };
  whatsapp: Record<string, unknown>;
};
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => integrations,
  }),
}));

vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/pay/[transferId]/route';

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

function post(id: string) {
  // Bodyless POST — destination already set (re-opened-link path); the OTP
  // gate is stubbed open above.
  const req = new NextRequest('http://localhost/api/pay/' + id, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ transferId: id }) });
}

const fetchMock = vi.fn();
const workerCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/worker')).length;

/** Start every captured after() callback; delayed ones park on setTimeout. */
function startCallbacks() {
  return Promise.allSettled(captured.afterCallbacks.map((cb) => Promise.resolve().then(cb)));
}

beforeEach(async () => {
  // Ordering rule: PGlite freshDb() BEFORE any vi.useFakeTimers() (which the
  // tests only enable AFTER the POST completes — the route does real DB work).
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
  integrations = { kyc: {}, payment: {}, whatsapp: {} }; // default: mock rail
  captured.afterCallbacks.length = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pay route — delayed best-effort poke for the delivered message', () => {
  it('mock rail (started, non-webhook-driven): a SECOND worker poke fires after DELIVERY_DELAY_MS + 10s', async () => {
    await store.saveTransfer(makeTransfer({ id: 'd1' }));
    const res = await post('d1');
    expect(res.status).toBe(200);
    expect((await store.getTransfer('d1'))?.status).toBe('paid');

    // Immediate poke + delayed poke were both scheduled post-response.
    expect(captured.afterCallbacks).toHaveLength(2);

    vi.useFakeTimers();
    const settled = startCallbacks();
    await vi.advanceTimersByTimeAsync(0);
    expect(workerCalls()).toBe(1); // immediate poke (stage-1 message is READY)

    // The delayed poke holds through the full simulated delivery delay…
    await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS - 1);
    expect(workerCalls()).toBe(1);

    // …and fires once the +10s buffer elapses (row is past its runAt by then).
    await vi.advanceTimersByTimeAsync(10_001);
    await settled;
    expect(workerCalls()).toBe(2);
  });

  it('webhook-driven rail (simulator): NO delayed poke is scheduled', async () => {
    integrations = { kyc: {}, payment: { providerType: 'simulator' }, whatsapp: {} };
    await store.saveTransfer(makeTransfer({ id: 'd2' }));
    const res = await post('d2');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'processing' });

    // Only the immediate poke — delivery arrives via the partner's callback.
    expect(captured.afterCallbacks).toHaveLength(1);

    vi.useFakeTimers();
    const settled = startCallbacks();
    await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS + 60_000);
    await settled;
    expect(workerCalls()).toBe(1);
  });

  it("'already' replay (double submit): NO delayed poke is scheduled", async () => {
    // Not awaiting_payment anymore ⇒ beginSettlement returns kind 'already'.
    await store.saveTransfer(makeTransfer({ id: 'd3', status: 'paid' }));
    const res = await post('d3');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });

    expect(captured.afterCallbacks).toHaveLength(1); // immediate poke only

    vi.useFakeTimers();
    const settled = startCallbacks();
    await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS + 60_000);
    await settled;
    expect(workerCalls()).toBe(1);
  });

  it('a rejecting worker fetch is swallowed — no unhandled rejection', async () => {
    fetchMock.mockRejectedValue(new Error('worker unreachable'));
    await store.saveTransfer(makeTransfer({ id: 'd4' }));
    const res = await post('d4');
    expect(res.status).toBe(200);
    expect(captured.afterCallbacks).toHaveLength(2);

    vi.useFakeTimers();
    const settled = startCallbacks();
    await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS + 10_001);
    const results = await settled;

    // Both pokes attempted the fetch…
    expect(workerCalls()).toBe(2);
    // …and BOTH callbacks resolved cleanly (errors swallowed inside the poke).
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});
