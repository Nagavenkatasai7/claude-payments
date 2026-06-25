/**
 * U2 — B2B ACH-pull pay submission (NON-CUSTODIAL). The sacred invariant:
 * SmartRemit captures NO funds for `fundingMethod === 'ach_pull'` — the licensed
 * partner ACH-debits the payer via the signed settlement instruction. So the pay
 * route must SKIP captureFunding() entirely and proceed straight to
 * beginSettlement, binding an opaque achTokenRef on the transfer. The b2c
 * card/bank_transfer capture path is unchanged (covered by pay-route-funding.test.ts).
 *
 * Mirrors pay-route-funding.test.ts so the two suites share the same seams.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';

const captured = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
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

vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }), // mock rail
  }),
}));

vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

// The capture seam under test: MUST NOT be called for ach_pull.
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return {
    ...real,
    getFundingProvider: () => ({
      capture: (...a: unknown[]) => {
        captured.order.push('capture');
        return capture(...a);
      },
      refund: vi.fn(),
      handleWebhook: vi.fn(),
    }),
  };
});

const observed = vi.hoisted(() => ({
  statusAtSettle: undefined as string | undefined,
  achTokenRefAtSettle: undefined as string | undefined,
}));
vi.mock('@/lib/settlement', async (orig) => {
  const real = await orig<typeof import('@/lib/settlement')>();
  return {
    ...real,
    beginSettlement: async (...args: Parameters<typeof real.beginSettlement>) => {
      captured.order.push('settle');
      const t = await store.getTransfer(args[1].id);
      observed.statusAtSettle = t?.status;
      observed.achTokenRefAtSettle = t?.achTokenRef;
      return real.beginSettlement(...args);
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

function makeB2bTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 5000, feeUsd: 0, totalChargeUsd: 5000, fxRate: 85,
    amountInr: 425000, recipientName: 'Acme Supplies', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'ach_pull',
    transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
    senderBusinessName: 'Buyer LLC', recipientBusinessName: 'Acme Supplies Pvt Ltd',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 5000, feeSource: 0, totalChargeSource: 5000, ...o,
  };
}

function postAch(id: string, ach: Record<string, string> = {
  routingNumber: '021000021', accountNumber: '1234567890', accountType: 'checking',
}) {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ach, otp: '000000' }),
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) });
}

const outboxCount = async () => {
  const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as {
    rows: Array<{ n: number }>;
  };
  return rows.rows[0].n;
};

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
  captured.afterCallbacks.length = 0;
  captured.order.length = 0;
  observed.statusAtSettle = undefined;
  observed.achTokenRefAtSettle = undefined;
  sendText.mockClear();
  capture.mockReset();
  capture.mockResolvedValue({ fundingRef: 'fund-should-not-be-called' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pay route — B2B ACH-pull (non-custodial: NO funds capture)', () => {
  it('ach_pull pay: captureFunding is NEVER called, settlement proceeds, achTokenRef is bound', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'b1' }));
    const res = await postAch('b1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });

    // THE SACRED INVARIANT: SmartRemit captured nothing — the partner pulls.
    expect(capture).not.toHaveBeenCalled();
    expect(captured.order).not.toContain('capture');

    // Settlement still ran, after an opaque achTokenRef was made durable.
    expect(captured.order).toContain('settle');
    expect(observed.statusAtSettle).toBe('awaiting_payment');
    expect(observed.achTokenRefAtSettle).toMatch(/^ach_[0-9a-f]+$/);

    const after = await store.getTransfer('b1');
    expect(after?.status).toBe('paid');
    expect(after?.achTokenRef).toMatch(/^ach_[0-9a-f]+$/);
    // No funding charge was ever recorded.
    expect(after?.fundingRef).toBeUndefined();

    // Settlement effects committed (stage-1 message + rail effect).
    expect(await outboxCount()).toBeGreaterThanOrEqual(2);
  });

  it('the bound achTokenRef carries NO raw routing/account digits', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'b2' }));
    await postAch('b2', { routingNumber: '021000021', accountNumber: '9876543210', accountType: 'savings' });
    const after = await store.getTransfer('b2');
    expect(after?.achTokenRef).toBeDefined();
    expect(after?.achTokenRef).not.toContain('021000021');
    expect(after?.achTokenRef).not.toContain('9876543210');
  });

  it('invalid ACH bank fields → 400 BEFORE settlement; nothing mutated, no capture', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'b3' }));
    const res = await postAch('b3', { routingNumber: '123', accountNumber: '1', accountType: 'checking' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors?: Record<string, string> };
    expect(body.fieldErrors?.routingNumber).toBeTruthy();
    expect(body.fieldErrors?.accountNumber).toBeTruthy();

    expect(capture).not.toHaveBeenCalled();
    expect(captured.order).not.toContain('settle');
    const after = await store.getTransfer('b3');
    expect(after?.status).toBe('awaiting_payment');
    expect(after?.achTokenRef).toBeUndefined();
    expect(await outboxCount()).toBe(0);
  });

  it('unverified business sender → 403 kyc_required; no capture, no settlement', async () => {
    await customerStore.saveCustomer({
      senderPhone: '15551234567', firstSeenAt: new Date().toISOString(), kycStatus: 'pending',
      senderCountry: 'US', partnerId: 'default', optInAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.saveTransfer(makeB2bTransfer({ id: 'b4' }));
    const res = await postAch('b4');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kyc_required: true });

    expect(capture).not.toHaveBeenCalled();
    expect(captured.order).not.toContain('settle');
    expect((await store.getTransfer('b4'))?.achTokenRef).toBeUndefined();
  });

  it('blocked compliance → 400 and capture is NEVER called (also for ach_pull)', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'b5', complianceStatus: 'blocked' }));
    const res = await postAch('b5');
    expect(res.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });

  it('replay POST keeps the first achTokenRef (idempotent token bind)', async () => {
    await store.saveTransfer(makeB2bTransfer({ id: 'b6' }));
    await postAch('b6');
    const first = (await store.getTransfer('b6'))?.achTokenRef;
    expect(first).toBeDefined();

    const replay = await postAch('b6');
    expect(replay.status).toBe(200);
    expect((await store.getTransfer('b6'))?.achTokenRef).toBe(first);
    // Still never captured.
    expect(capture).not.toHaveBeenCalled();
  });
});
