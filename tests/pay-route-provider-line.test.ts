/**
 * Fix pack 4 T18 (C22 c, R16): the pay route's request_otp hands
 * sendTransactionOtp the OWNER's approved provider line as hooks.providerLine,
 * taken from the request_otp gate context (no extra partner read). Without an
 * approved line (unapproved, default tenant, a value naming the platform, a
 * failed owner read) the hooks object has no providerLine key at all, so the
 * code text is byte-identical to today. Harness: tests/pay-route-r18-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { approveDisclosureForTest, certifyPartnerForTest } from './helpers-live';
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
const drafts = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async (id: string) => drafts.get(id) ?? null }) }));
// The partner STORE (brand, channel rule) knows no partner: the shared number.
// The gate context reads the owner from PGlite (partner-repo).
const partnerStoreReads = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => {
      partnerStoreReads.n += 1;
      return null;
    },
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));
vi.mock('@/lib/ip-rate-limit', async (orig) => ({ ...(await orig<typeof import('@/lib/ip-rate-limit')>()), enforceIpRateLimit: async () => null }));
// The gate context's owner read: `fault.throwOnceFor` makes the next read of that id throw.
const fault = vi.hoisted(() => ({ throwOnceFor: null as string | null }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const repo = real.createPartnerRepo(...a);
      return {
        ...repo,
        getPartner: async (id: Parameters<typeof repo.getPartner>[0]) => {
          if (fault.throwOnceFor === id) {
            fault.throwOnceFor = null;
            throw new Error('owner read failed');
          }
          return repo.getPartner(id);
        },
      };
    },
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';
const TID = 'tx_line_1';
const LINE = 'Payments by Acme Money Services LLC, licensed by State Department of Financial Services';
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'user-agent': 'LineTestBrowser/1.0' };

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

const post = (id: string, b: object) =>
  POST(new NextRequest('http://x/api/pay/' + id, { method: 'POST', body: JSON.stringify(b), headers: HEADERS }), {
    params: Promise.resolve({ transferId: id }),
  });
const hooks = () => sendTransactionOtp.mock.calls[0][5] as Record<string, unknown>;

beforeEach(async () => {
  db = await freshDb();
  const redis = fakeRedis();
  store = createStore(redis, db);
  customerStore = createCustomerStore(db, store);
  txOtp = createTransactionOtpStore(redis, { randomInt: () => 654321 });
  await seedPartner(db, 'acme');
  await certifyPartnerForTest(db, 'acme');
  await customerStore.saveCustomer(customerFor('acme'));
  sendTransactionOtp.mockReset();
  sendTransactionOtp.mockResolvedValue(undefined);
  drafts.clear();
  fault.throwOnceFor = null;
  partnerStoreReads.n = 0;
});

describe('pay route request_otp: hooks.providerLine (pack 4 T18, C22 c)', { retry: 0 }, () => {
  it('approved owner -> hooks.providerLine is the exact line; purpose, inWindow and onTemplateFailure unchanged', async () => {
    await approveDisclosureForTest(db, 'acme');
    await store.saveTransfer(makeTransfer({ id: TID }));
    const res = await post(TID, { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    const h = hooks();
    expect(h.providerLine).toBe(LINE);
    expect(h.purpose).toBe('payment');
    expect(typeof h.inWindow).toBe('function');
    expect(typeof h.onTemplateFailure).toBe('function');
    expect(Object.keys(h).sort()).toEqual(['inWindow', 'onTemplateFailure', 'providerLine', 'purpose']);
  });

  it('the line adds no partner read: the same partner-store reads as an unapproved owner', async () => {
    await store.saveTransfer(makeTransfer({ id: TID }));
    await approveDisclosureForTest(db, 'acme');
    await post(TID, { action: 'request_otp' });
    const withLine = partnerStoreReads.n;
    expect(hooks().providerLine).toBe(LINE);
    await seedPartner(db, 'plain');
    await customerStore.saveCustomer(customerFor('plain'));
    await store.saveTransfer(makeTransfer({ id: 'tx_line_2', partnerId: 'plain' }));
    partnerStoreReads.n = 0;
    sendTransactionOtp.mockClear();
    await post('tx_line_2', { action: 'request_otp' });
    expect(hooks()).not.toHaveProperty('providerLine');
    expect(withLine).toBe(partnerStoreReads.n);
  });

  it('unapproved owner (not mandatory: uncertified, mock rail) -> no providerLine key, still purpose payment', async () => {
    await seedPartner(db, 'plain');
    await customerStore.saveCustomer(customerFor('plain'));
    await store.saveTransfer(makeTransfer({ id: TID, partnerId: 'plain' }));
    const res = await post(TID, { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(hooks()).not.toHaveProperty('providerLine');
    expect(hooks()).toMatchObject({ purpose: 'payment' });
  });

  it('an approved block whose entity or regulator names SmartRemit -> no key (C16, critic P10)', async () => {
    for (const o of [{ entity: 'SmartRemit Money Services LLC' }, { regulator: 'SmartRemit Licensing Board' }]) {
      sendTransactionOtp.mockClear();
      await approveDisclosureForTest(db, 'acme', o);
      await store.saveTransfer(makeTransfer({ id: TID }));
      const res = await post(TID, { action: 'request_otp' });
      expect(res.status).toBe(200);
      expect(hooks()).not.toHaveProperty('providerLine');
      // The code store is reset between the two posts so the cooldown never answers instead.
      txOtp = createTransactionOtpStore(fakeRedis(), { randomInt: () => 654321 });
    }
  });

  it('default tenant -> no key', async () => {
    await customerStore.saveCustomer(customerFor('default'));
    await store.saveTransfer(makeTransfer({ id: TID, partnerId: 'default' }));
    const res = await post(TID, { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(hooks()).not.toHaveProperty('providerLine');
    expect(hooks()).toMatchObject({ purpose: 'payment' });
  });

  it('the owner read fails (gate context ownerReadFailed) -> no key, the code is still sent', async () => {
    await seedPartner(db, 'plain');
    await approveDisclosureForTest(db, 'plain');
    await customerStore.saveCustomer(customerFor('plain'));
    await store.saveTransfer(makeTransfer({ id: TID, partnerId: 'plain' }));
    fault.throwOnceFor = 'plain';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const res = await post(TID, { action: 'request_otp' });
    expect(fault.throwOnceFor).toBeNull(); // the gate context's read did throw
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    expect(hooks()).not.toHaveProperty('providerLine');
  });

  it("a draft -> the draft tenant's line", async () => {
    await seedPartner(db, 'drafty');
    await approveDisclosureForTest(db, 'drafty', { entity: 'Drafty Money LLC', regulator: 'Drafty State Banking Department' });
    drafts.set('d_line', { senderPhone: PHONE, partnerId: 'drafty' });
    const res = await post('d_line', { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(hooks().providerLine).toBe('Payments by Drafty Money LLC, licensed by Drafty State Banking Department');
  });

  it('pay (not request_otp) never calls sendTransactionOtp', async () => {
    await approveDisclosureForTest(db, 'acme');
    await store.saveTransfer(makeTransfer({ id: TID }));
    await post(TID, { otp: '000000' });
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });
});
