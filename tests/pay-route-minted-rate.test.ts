/**
 * Step 0 FX-2 (P1): the pay route re-checks an EXISTING transfer's rate before
 * any code is issued or verified, behind FX_PAY_RATE_CHECK_ENABLED (default
 * OFF). A plain row that drifted > 0.5% is cancelled (+ one audit row, no
 * outbox row) and answers 409 rate_expired; a row with a bound funding intent
 * answers 409 rate_expired_payment_pending and is never cancelled. Relative
 * times only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { resetRateCacheForTests } from '@/lib/rate';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer, Customer } from '@/lib/types';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});

const sendTransactionOtp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp,
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
// The funding seam: a capture spy proves a refused row is never charged.
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return { ...real, getFundingProvider: () => ({ capture, refund: vi.fn(), handleWebhook: vi.fn() }) };
});

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';
const TID = 'tr_minted_1';
const HOUR = 3_600_000;
const MINTED_RATE = 85;
const T0 = new Date(Date.now() - 40 * 86_400_000).toISOString();
const customer: Customer = {
  senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Test Sender', senderCountry: 'US',
  partnerId: 'default', createdAt: T0, updatedAt: T0,
} as Customer;

function row(o: Partial<Transfer> = {}): Transfer {
  return {
    id: TID, phone: PHONE, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: MINTED_RATE, amountInr: 17000,
    recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    // A scheduled row minted 2 h ago: past the 60-min lock.
    createdAt: new Date(Date.now() - 2 * HOUR).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 0,
    totalChargeSource: 200, ...o,
  } as Transfer;
}

/** Frankfurter answers USD→INR at `inr`, dated today (a current fixing). */
function stubFx(inr: number) {
  const date = new Date().toISOString().slice(0, 10);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ date, rates: { INR: inr } }) })));
}

const req = (b: object) =>
  new NextRequest('http://x/api/pay/' + TID, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const ctx = { params: Promise.resolve({ transferId: TID }) };
const current = async () => store.getTransfer(TID);
const auditRows = async () =>
  ((await db.execute(sql`SELECT partner_id, action, subject_id, meta FROM audit_events WHERE action = 'transfer.rate_expired'`)) as unknown as {
    rows: Array<{ partner_id: string | null; action: string; subject_id: string; meta: Record<string, unknown> }>;
  }).rows;
const outboxCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;

beforeEach(async () => {
  const r = fakeRedis();
  db = await freshDb();
  store = createStore(r, db);
  customerStore = createCustomerStore(db, store);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  await customerStore.saveCustomer(customer);
  resetRateCacheForTests();
  sendTransactionOtp.mockClear();
  capture.mockReset().mockResolvedValue({ fundingRef: 'mockfund-x' });
  vi.stubEnv('FX_PAY_RATE_CHECK_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('flag ON: a plain row whose rate drifted 1% is refused and cancelled', () => {
  beforeEach(async () => {
    await store.saveTransfer(row());
    stubFx(MINTED_RATE * 1.01);
  });

  it('request_otp → 409 rate_expired + status cancelled; no code issued; one audit row with partnerId; no outbox row', async () => {
    const issue = vi.spyOn(txOtp, 'issue');
    const res = await POST(req({ action: 'request_otp' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'rate_expired', status: 'cancelled' });
    expect(issue).not.toHaveBeenCalled();
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect((await current())?.status).toBe('cancelled');
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ partner_id: 'default', subject_id: TID });
    expect(audits[0].meta).toMatchObject({ reason: 'drift', driftBps: 99 });
    expect(await outboxCount()).toBe(0);
  });

  it('a pay POST → the same 409; the OTP is never verified and nothing is captured', async () => {
    await txOtp.issue(TID, PHONE);
    const verify = vi.spyOn(txOtp, 'verify');
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('rate_expired');
    expect(verify).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect((await current())?.status).toBe('cancelled');
    expect(await auditRows()).toHaveLength(1);
  });

  it('a second POST after the cancel answers current truth (200 cancelled) without a second audit or FX fetch', async () => {
    await POST(req({ action: 'request_otp' }), ctx);
    vi.mocked(global.fetch).mockClear();
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(await res.json()).toEqual({ ok: true, status: 'cancelled' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('flag ON: rows that proceed', () => {
  it('drift within 0.5% → request_otp sends a code and pay settles', async () => {
    await store.saveTransfer(row());
    stubFx(MINTED_RATE * 1.002);
    expect((await (await POST(req({ action: 'request_otp' }), ctx)).json()).sent).toBe(true);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(res.status).toBe(200);
    expect((await current())?.status).toBe('paid');
  });

  it('a row inside the 60-min lock proceeds with NO FX fetch', async () => {
    await store.saveTransfer(row({ createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
    stubFx(MINTED_RATE * 1.05);
    expect((await (await POST(req({ action: 'request_otp' }), ctx)).json()).sent).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a captured row (fundingRef set, or fundingState succeeded) proceeds unchecked', async () => {
    stubFx(MINTED_RATE * 1.05);
    await store.saveTransfer(row({ fundingRef: 'mockfund-earlier' }));
    expect((await (await POST(req({ action: 'request_otp' }), ctx)).json()).sent).toBe(true);
    await db.execute(sql`UPDATE transfers SET funding_ref = NULL, funding_provider = 'stripe', funding_intent_ref = 'pi_x', funding_state = 'succeeded' WHERE id = ${TID}`);
    expect((await (await POST(req({ action: 'request_otp' }), ctx)).json()).sent).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a partner-API-minted row proceeds unchecked (the partner owns confirm, N3)', async () => {
    await store.saveTransfer(row());
    await createIdempotencyRepo(db).claim('default', 'order-77', TID);
    stubFx(MINTED_RATE * 1.05);
    expect((await (await POST(req({ action: 'request_otp' }), ctx)).json()).sent).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await current())?.status).toBe('awaiting_payment');
  });

  it('a B2B row proceeds unchecked', async () => {
    await store.saveTransfer(row({ transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business' }));
    stubFx(MINTED_RATE * 1.05);
    expect((await (await POST(req({ action: 'request_otp' }), ctx)).json()).sent).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a paid row is never fetched or audited: the pay POST answers current truth', async () => {
    await store.saveTransfer(row({ status: 'paid' }));
    stubFx(MINTED_RATE * 1.05);
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('flag ON: special refusals', () => {
  it('FX unavailable → 503 fx_unavailable; nothing written, row still payable', async () => {
    await store.saveTransfer(row());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const res = await POST(req({ action: 'request_otp' }), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'fx_unavailable' });
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect((await current())?.status).toBe('awaiting_payment');
    expect(await auditRows()).toHaveLength(0);
  });

  it('a row with a bound funding intent → 409 rate_expired_payment_pending; never cancelled, never audited, never funded', async () => {
    await store.saveTransfer(row());
    await db.execute(sql`UPDATE transfers SET funding_provider = 'stripe', funding_intent_ref = 'pi_pending', funding_state = 'pending' WHERE id = ${TID}`);
    stubFx(MINTED_RATE * 1.01);
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'rate_expired_payment_pending' });
    expect((await current())?.status).toBe('awaiting_payment');
    expect(await auditRows()).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('a ROUTED row past the lock → 409 rate_expired (routed_stale) with no FX fetch', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'p_rail');
    await store.saveTransfer(row({ settlementPartnerId: 'p_rail' }));
    stubFx(MINTED_RATE);
    const res = await POST(req({ action: 'request_otp' }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('rate_expired');
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await auditRows())[0].meta).toMatchObject({ reason: 'routed_stale' });
  });
});

describe('flag OFF (default): identical to today', () => {
  it('a 1%-drifted 2-h-old row sends a code and pays, with no FX fetch', async () => {
    vi.unstubAllEnvs();
    await store.saveTransfer(row());
    stubFx(MINTED_RATE * 1.01);
    expect((await (await POST(req({ action: 'request_otp' }), ctx)).json()).sent).toBe(true);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(res.status).toBe(200);
    expect((await current())?.status).toBe('paid');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });
});
