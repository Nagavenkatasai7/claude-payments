/**
 * Fix pack 5 T13b (P13 route pre-verify, M5): the pay route [transferId]
 * refuses a real-money payment whose rail is unsigned, or whose funding would
 * be the mock, BEFORE a code is issued (request_otp) and BEFORE the code is
 * checked (pay): no code is spent, no evidence, no legal name, no mint.
 * pay-process steps 5 and 7 stay the backstop (tests/pay-funding-refusal.test.ts).
 *
 * Owner 'acme': seeded in PGlite, certified, its provider block approved (so
 * the pack 4 R18 pre-verify passes), on an http rail (real money). The real
 * transaction-OTP store runs on a fake Redis, so "the code is not consumed" is
 * observable; the real integrations repo runs on PGlite, wrapped so the reads
 * the money gate makes are counted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { fixedReply } from '@/lib/hold-replies';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest, certifyPartnerForTest, seedRealMoneyRail } from './helpers-live';
import { realMoneyPayBody } from './helpers-pay-evidence';
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
let redis: ReturnType<typeof fakeRedis>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
const drafts = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async (id: string) => drafts.get(id) ?? null }) }));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));
// The real integrations repo on PGlite; `inGate` marks the reads the money gate makes.
const seam = vi.hoisted(() => ({ inGate: false, gateReads: 0, gateCalls: 0 }));
vi.mock('@/lib/partner-integrations-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-integrations-store')>();
  return {
    ...real,
    getPartnerIntegrationsStore: () => {
      const s = real.createPartnerIntegrationsStore(db);
      return {
        ...s,
        getIntegrations: async (id: string) => {
          if (seam.inGate) seam.gateReads++;
          return s.getIntegrations(id);
        },
        getFundingConfig: async (id: string) => {
          if (seam.inGate) seam.gateReads++;
          return s.getFundingConfig(id);
        },
      };
    },
  };
});
vi.mock('@/lib/pay-money-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/pay-money-gate')>();
  return {
    ...real,
    payMoneyGateRefusal: async (...a: Parameters<typeof real.payMoneyGateRefusal>) => {
      seam.gateCalls++;
      seam.inGate = true;
      try {
        return await real.payMoneyGateRefusal(...a);
      } finally {
        seam.inGate = false;
      }
    },
  };
});
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn }));
vi.mock('@/lib/ip-rate-limit', async (orig) => ({ ...(await orig<typeof import('@/lib/ip-rate-limit')>()), enforceIpRateLimit: async () => null }));
const finalize = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pay-finalize', async (orig) => ({ ...(await orig<typeof import('@/lib/pay-finalize')>()), finalizeDraftPayment: finalize }));

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';
const TID = 'tx_mg_1';
const DID = 'd_mg_1';
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'user-agent': 'MoneyGateBrowser/1.0' };

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205, fxRate: 85, amountInr: 17000,
    recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '123456789012 HDFC0001234',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date(Date.now() - 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
    destinationCurrency: 'INR', partnerId: 'acme', amountSource: 200, feeSource: 5, totalChargeSource: 205, ...o,
  } as Transfer;
}
const customerFor = (partnerId: string): Customer => {
  const t0 = new Date(Date.now() - 86_400_000).toISOString();
  return { senderPhone: PHONE, firstSeenAt: t0, kycStatus: 'verified', fullName: 'Test Sender', senderCountry: 'US', partnerId, createdAt: t0, updatedAt: t0 } as Customer;
};
const draftFor = (partnerId: string) => ({
  senderPhone: PHONE, partnerId, fundingMethod: 'bank_transfer', transferType: 'b2c',
  amountUsd: 200, recipientName: 'Mom', recipientPhone: '919876543210', destinationCountry: 'IN',
});

const post = (id: string, b: object) =>
  POST(new NextRequest('http://x/api/pay/' + id, { method: 'POST', body: JSON.stringify(b), headers: HEADERS }), {
    params: Promise.resolve({ transferId: id }),
  });

const NOT_AVAILABLE = { ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' };
const codeKeys = () => [...redis.dump.keys()].filter((k) => /^txotp:[0-9a-f]+$/.test(k));
const auditActions = async (): Promise<string[]> =>
  ((await db.execute(sql`SELECT action FROM audit_events ORDER BY id`)) as unknown as { rows: Array<{ action: string }> }).rows.map(
    (r) => r.action,
  );
const transferIds = async (): Promise<string[]> =>
  ((await db.execute(sql`SELECT id FROM transfers ORDER BY id`)) as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
const legalNameEnc = async (id: string) =>
  ((await db.execute(sql`SELECT recipient_legal_name_enc FROM transfers WHERE id = ${id}`)) as unknown as {
    rows: Array<{ recipient_legal_name_enc: string | null }>;
  }).rows[0]?.recipient_legal_name_enc ?? null;
const refusalLogs = () => logWarn.mock.calls.filter(([scope]) => scope === 'pay.preverify-refused');

beforeEach(async () => {
  redis = fakeRedis();
  db = await freshDb();
  store = createStore(redis, db);
  customerStore = createCustomerStore(db, store);
  txOtp = createTransactionOtpStore(redis, { randomInt: () => 654321 });
  await seedPartner(db, 'acme');
  await certifyPartnerForTest(db, 'acme');
  await approveDisclosureForTest(db, 'acme');
  await seedRealMoneyRail(db, 'acme');
  await store.saveTransfer(makeTransfer({ id: TID }));
  await customerStore.saveCustomer(customerFor('acme'));
  sendTransactionOtp.mockReset();
  sendTransactionOtp.mockResolvedValue(undefined);
  drafts.clear();
  finalize.mockReset();
  logWarn.mockReset();
  seam.inGate = false;
  seam.gateReads = 0;
  seam.gateCalls = 0;
  delete process.env.STRIPE_FUNDING_ENABLED;
});
afterEach(() => {
  delete process.env.STRIPE_FUNDING_ENABLED;
  vi.unstubAllGlobals();
});

describe('real money, mock funded (P13 route pre-verify)', { retry: 0 }, () => {
  it('request_otp: 409 PAY_NOT_AVAILABLE, no code issued, nothing sent', async () => {
    const res = await post(TID, { action: 'request_otp' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_AVAILABLE);
    expect(codeKeys()).toEqual([]);
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([['pay.preverify-refused', 'money gate', { transferId: TID, code: 'mock_on_real_money' }]]);
  });

  it('pay: 409 before verify; the code is NOT spent, no evidence, no legal name; once lifted the same code verifies', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_AVAILABLE);
    expect(codeKeys()).toHaveLength(1);
    expect(await auditActions()).not.toContain('otp.verified');
    expect(await auditActions()).not.toContain('customer.travel_rule_set');
    expect((await store.getTransfer(TID))?.status).toBe('awaiting_payment');
    expect(await legalNameEnc(TID)).toBeNull();
    expect(refusalLogs()).toEqual([['pay.preverify-refused', 'money gate', { transferId: TID, code: 'mock_on_real_money' }]]);

    // Lift the gate in the same test: the owner gets a Stripe funding config.
    await createIntegrationsRepo(db).setFundingConfig('acme', { providerType: 'stripe', secretKey: 'rk_test_moneygate' });
    process.env.STRIPE_FUNDING_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'stubbed' } }), { status: 500 })));
    const again = await post(TID, realMoneyPayBody());
    expect(again.status).not.toBe(403);
    expect((await again.clone().json()).reason).not.toBe('otp');
    expect(codeKeys()).toEqual([]); // the SAME code verified (and was consumed) this time
    expect(await auditActions()).toContain('otp.verified');
  });

  it('the draft branch: request_otp 409 and pay 409 before verify, no mint, draftId in the log', async () => {
    drafts.set(DID, draftFor('acme'));
    const req = await post(DID, { action: 'request_otp' });
    expect(req.status).toBe(409);
    expect(codeKeys()).toEqual([]);
    await txOtp.issue(DID, PHONE);
    const res = await post(DID, realMoneyPayBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_AVAILABLE);
    expect(codeKeys()).toHaveLength(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(await transferIds()).toEqual([TID]);
    expect(await auditActions()).not.toContain('otp.verified');
    expect(refusalLogs()).toEqual([
      ['pay.preverify-refused', 'money gate', { draftId: DID, code: 'mock_on_real_money' }],
      ['pay.preverify-refused', 'money gate', { draftId: DID, code: 'mock_on_real_money' }],
    ]);
  });
});

describe('an unsigned http rail', { retry: 0 }, () => {
  beforeEach(async () => {
    await seedRealMoneyRail(db, 'acme', { signingSecret: null });
  });

  it("request_otp and pay: the same 409, code 'rail_unsigned' in the log, the code not spent", async () => {
    const req = await post(TID, { action: 'request_otp' });
    expect(req.status).toBe(409);
    expect(await req.json()).toEqual(NOT_AVAILABLE);
    expect(codeKeys()).toEqual([]);
    await txOtp.issue(TID, PHONE);
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_AVAILABLE);
    expect(codeKeys()).toHaveLength(1);
    expect(refusalLogs()).toEqual([
      ['pay.preverify-refused', 'money gate', { transferId: TID, code: 'rail_unsigned' }],
      ['pay.preverify-refused', 'money gate', { transferId: TID, code: 'rail_unsigned' }],
    ]);
  });
});

describe('demo unchanged: the gate makes no read', { retry: 0 }, () => {
  it('the default tenant on the mock rail: a code is sent and the payment is paid', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tx_def', partnerId: 'default' }));
    await customerStore.saveCustomer(customerFor('default'));
    const req = await post('tx_def', { action: 'request_otp' });
    expect(req.status).toBe(200);
    const res = await post('tx_def', { otp: '654321' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    expect(seam.gateCalls).toBeGreaterThanOrEqual(2);
    expect(seam.gateReads).toBe(0);
    expect(refusalLogs()).toEqual([]);
  });

  it('a simulator rail: a code is sent and the payment goes on as today, no gate read', async () => {
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {},
      whatsapp: {},
      payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://x/api/partner-rail', signingSecret: 'sim' }, webhookSecret: 'w' },
    });
    const req = await post(TID, { action: 'request_otp' });
    expect(req.status).toBe(200);
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(200);
    expect(seam.gateCalls).toBeGreaterThanOrEqual(2);
    expect(seam.gateReads).toBe(0);
    expect(refusalLogs()).toEqual([]);
  });
});
