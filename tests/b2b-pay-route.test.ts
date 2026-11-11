/**
 * Program-Fix 44 (P3, b2b-04): the cross-border B2B pay route refuses an
 * UNPAID bill older than B2B_BILL_TTL_DAYS with the generic dead-bill answer —
 * before the confirmation-code step, so an expired link can neither trigger a
 * code send nor reach the claim-first mint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PAY_NOT_AVAILABLE } from '@/lib/pay-not-available';
import { fixedReply } from '@/lib/hold-replies';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

const DAY = 24 * 60 * 60 * 1000;
let createdAt = new Date().toISOString();
// Fix pack 2 T9: the settle-time backstop case runs settleOrHold on a real
// PGlite ledger; every other case keeps the inert stubs (state unset).
const state = vi.hoisted(() => ({
  db: null as unknown,
  transfer: null as unknown,
  integrations: null as unknown,
}));
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    getB2bInvoice: async (id: string) => ({
      id, partnerId: 'default', businessName: 'Seller Co', buyerPhone: '15550001111',
      lineItems: [], amountUsd: 500, currency: 'USD', sellerId: 's_1',
      invoicedAmount: 500, invoicedCurrency: 'USD', status: 'unpaid', createdAt,
    }),
    getSellerById: async () => ({ id: 's_1', partnerId: 'default', status: 'active', currency: 'USD' }),
    getTransfer: async () => state.transfer,
  }),
}));
vi.mock('@/lib/b2b-quote-store', () => ({
  getB2bQuoteStore: () => ({
    getLockedQuote: async () => ({
      sellerAmount: 500, sellerCurrency: 'USD', buyerCurrency: 'USD',
      buyerPrincipal: 500, feeBuyer: 1.99, buyerTotal: 501.99, fxRate: 1, lockedAt: new Date().toISOString(),
    }),
  }),
}));
vi.mock('@/lib/customer-store', () => ({
  getCustomerStore: () => ({ getCustomer: async () => ({ kycStatus: 'verified', fullName: 'Buyer Ltd' }) }),
}));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({ getPartner: async () => ({ id: 'default', kycMode: 'delegated', countries: ['US'] }) }),
}));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/db/client', () => ({ getDb: () => state.db ?? {} }));
const verify = vi.hoisted(() => vi.fn());
const issue = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({ issue, verify }),
}));
const sendTransactionOtp = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp', async (orig) => ({ ...(await orig<typeof import('@/lib/whatsapp')>()), sendTransactionOtp }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => state.integrations ?? { kyc: {}, payment: {}, whatsapp: {} },
  }),
}));
const finalizeCrossBorderBillPayment = vi.hoisted(() => vi.fn());
vi.mock('@/lib/b2b-pay-finalize', () => ({ finalizeCrossBorderBillPayment }));

import { POST } from '@/app/api/pay/b2b/[invoiceId]/route';

const call = (body: Record<string, unknown>) =>
  POST(
    new NextRequest('http://x/api/pay/b2b/inv_1', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ invoiceId: 'inv_1' }) },
  );
const pay = () => call({ otp: '123456', fields: { routingNumber: '021000021', accountNumber: '12345678' } });

beforeEach(() => {
  state.db = null;
  state.transfer = null;
  state.integrations = null;
  verify.mockReset().mockResolvedValue({ ok: true });
  issue.mockReset().mockResolvedValue({ ok: true, code: '123456' });
  sendTransactionOtp.mockReset().mockResolvedValue(undefined);
  finalizeCrossBorderBillPayment.mockReset().mockResolvedValue({ ok: false, error: 'seller_unavailable' });
});

describe('POST /api/pay/b2b/[invoiceId] — bill expiry (Program-Fix 44)', { retry: 0 }, () => {
  it('an unpaid bill 31 days old → 404 "no longer active"; no code is verified and nothing is minted', async () => {
    createdAt = new Date(Date.now() - 31 * DAY).toISOString();
    const res = await pay();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'This bill is no longer active.' });
    expect(verify).not.toHaveBeenCalled();
    expect(finalizeCrossBorderBillPayment).not.toHaveBeenCalled();
  });

  it('request_otp on an expired bill → the same 404, and no code is issued or sent', async () => {
    createdAt = new Date(Date.now() - 31 * DAY).toISOString();
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'This bill is no longer active.' });
    expect(issue).not.toHaveBeenCalled();
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it('control: a 29-day-old bill proceeds to the code check and the mint', async () => {
    createdAt = new Date(Date.now() - 29 * DAY).toISOString();
    const res = await pay();
    expect(verify).toHaveBeenCalledOnce();
    expect(finalizeCrossBorderBillPayment).toHaveBeenCalledOnce();
    expect(res.status).toBe(400); // the stubbed finalize refusal, not the expiry gate
  });
});

// Pack 3 T3 (contract 5): a live control refused the mint ⇒ the neutral 409
// PAY_NOT_AVAILABLE, never the generic 400.
describe('POST /api/pay/b2b/[invoiceId] — not_available (pack 3)', { retry: 0 }, () => {
  it('finalize not_available ⇒ 409 PAY_NOT_AVAILABLE', async () => {
    createdAt = new Date(Date.now() - 1 * DAY).toISOString();
    finalizeCrossBorderBillPayment.mockResolvedValueOnce({ ok: false, error: 'not_available' });
    const res = await pay();
    expect(finalizeCrossBorderBillPayment).toHaveBeenCalledOnce();
    expect(res.status).toBe(PAY_NOT_AVAILABLE.status);
    expect(await res.json()).toEqual({ ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' });
  });
});

// ── Fix pack 2 T9 (R02): B2B pay settles through settleOrHold, so a real-money
// (http) rail whose mint screen was not on a live list is HELD, never instructed.
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { seedLiveEvidence } from './helpers-sanctions';
import { LIST_UNAVAILABLE_REASON } from '@/lib/compliance-config';
import type { Transfer } from '@/lib/types';

const HTTP_INTEGRATIONS = {
  kyc: {},
  payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' }, webhookSecret: 'w' },
  whatsapp: {},
};
/**
 * A minted live B2B transfer on a PGlite ledger, owned by `owner`, with the route's (stubbed)
 * integrations on an http rail. Pack 3: a non-default owner is seeded, and certified unless
 * `certify: false`.
 */
async function liveB2bOnHttp(o: { owner?: string; certify?: boolean; id?: string } = {}) {
  createdAt = new Date().toISOString();
  const owner = o.owner ?? 'acme';
  const id = o.id ?? 'b2b_t1';
  const db = await freshDb();
  if (owner !== 'default') {
    await seedPartner(db, owner);
    if (o.certify ?? true) await certifyPartnerForTest(db, owner);
  }
  const ledger = createTransferRepo(db);
  const t = {
    id, phone: '15550001111', amountUsd: 500, feeUsd: 1.99, totalChargeUsd: 501.99,
    fxRate: 1, amountInr: 0, recipientName: 'Seller Co', recipientPhone: '15550002222',
    payoutMethod: 'bank', payoutDestination: '12345678|021000021', fundingMethod: 'bank_pull',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date().toISOString(), partnerId: owner, environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'US', destinationCurrency: 'USD',
    amountSource: 500, feeSource: 1.99, totalChargeSource: 501.99,
  } as Transfer;
  await ledger.saveTransfer(t);
  await seedLiveEvidence(db, t, { listFitness: 'not_live' }); // the mint screened on the mock list
  state.db = db;
  state.transfer = t;
  state.integrations = HTTP_INTEGRATIONS;
  finalizeCrossBorderBillPayment.mockResolvedValue({ ok: true, transferId: id });
  const outbox = async () =>
    ((await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as {
      rows: Array<{ kind: string; dedupe_key: string }>;
    }).rows;
  return { db, ledger, outbox };
}

describe('POST /api/pay/b2b/[invoiceId] — settle-time live-list backstop (fix pack 2 T9)', { retry: 0 }, () => {
  it('http rail + mint evidence not live -> 200 in_review, no instruct', async () => {
    // Pack 3: the owner is a certified non-default partner (the pay-time live gate).
    const { ledger, outbox } = await liveB2bOnHttp();

    const res = await pay();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'in_review' });
    const after = await ledger.getTransfer('b2b_t1');
    expect(after?.status).toBe('in_review');
    expect(after?.complianceReasons).toEqual([LIST_UNAVAILABLE_REASON]);
    const rows = await outbox();
    expect(rows.map((r) => r.dedupe_key)).toEqual(['stage1:b2b_t1']);
    expect(rows.some((r) => r.kind === 'settlement.instruct')).toBe(false);
  });
});

// Pack 3 (contract 6): the B2B route settles an awaiting_payment row through settleOrHold
// only when its rail (the integrations it read) is not real money or is certified; the
// default tenant never owns a real-money transfer. Nothing is held, instructed or written.
describe('POST /api/pay/b2b/[invoiceId] — pay-time live gate (pack 3)', { retry: 0 }, () => {
  it('uncertified non-default http rail (stubbed integrations) -> 409 PAY_NOT_AVAILABLE, settleOrHold never runs, no outbox row', async () => {
    const { ledger, outbox } = await liveB2bOnHttp({ certify: false });
    const res = await pay();
    expect(res.status).toBe(PAY_NOT_AVAILABLE.status);
    expect(await res.json()).toEqual({ ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' });
    const after = await ledger.getTransfer('b2b_t1');
    expect(after?.status).toBe('awaiting_payment');
    expect(after?.complianceReasons).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('certified -> 200 as before', async () => {
    const { ledger } = await liveB2bOnHttp();
    const res = await pay();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'in_review' });
    expect((await ledger.getTransfer('b2b_t1'))?.status).toBe('in_review');
  });

  it("a 'default' owner with stubbed http integrations -> 409", async () => {
    const { ledger, outbox } = await liveB2bOnHttp({ owner: 'default' });
    const res = await pay();
    expect(res.status).toBe(PAY_NOT_AVAILABLE.status);
    expect((await res.json()).reason).toBe('not_available');
    expect((await ledger.getTransfer('b2b_t1'))?.status).toBe('awaiting_payment');
    expect(await outbox()).toEqual([]);
  });
});
