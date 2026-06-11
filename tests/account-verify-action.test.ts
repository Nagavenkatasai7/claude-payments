import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Store } from '@/lib/store';
import type { Customer } from '@/lib/types';

const PHONE = '15551230000';
// All stores (and the fake redis — its hash map is NOT cleared by dump.clear())
// are rebuilt per test in beforeEach (freshDb truncates the pg side) — the
// hoisted vi.mock factories below only dereference these at call time.
let redis: FakeRedis;
let cs: CustomerStore;
let kcs: ReturnType<typeof createKycCaseStore>;
let ps: PartnerStore;

const customer = { senderPhone: PHONE, firstSeenAt: '2026-01-01T00:00:00.000Z', kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as Customer;

// Hoisted spy so the gate-off case can assert the provider is NEVER touched —
// startVerification creates a REAL Persona inquiry.
const startVerification = vi.hoisted(() =>
  vi.fn(async () => ({ url: 'https://withpersona.com/verify?code=abc', providerRef: 'inq_1' })),
);

vi.mock('@/lib/customer-auth', () => ({ requireCustomer: async () => customer }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig() as object), getCustomerStore: () => cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig() as object), getKycCaseStore: () => kcs }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig() as object), getPartnerStore: () => ps }));
vi.mock('@/lib/providers/kyc-provider', () => ({ getKycProvider: () => ({ startVerification }) }));
vi.mock('next/navigation', () => ({ redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); } }));

import { startVerificationAction } from '@/app/account/verify/actions';

/** Flip the default partner's OPT-IN verify-before-send gate — the ROW decides. */
async function setGate(requireKycBeforeSend: boolean): Promise<void> {
  const dflt = await ps.ensureDefaultPartner();
  await ps.savePartner({ ...dflt, requireKycBeforeSend, updatedAt: new Date().toISOString() });
}

beforeEach(async () => {
  redis = fakeRedis();
  startVerification.mockClear();
  const db = await freshDb();
  cs = createCustomerStore(db, { firstTransferAt: async () => null } as unknown as Store);
  kcs = createKycCaseStore(redis, cs);
  ps = createPartnerStore(db);
  await cs.saveCustomer(customer);
  await setGate(true); // gate ON unless a test flips it off
});

describe('startVerificationAction', () => {
  it('gate on: starts an inquiry, records inquiry_started, redirects to the hosted-flow URL', async () => {
    await expect(startVerificationAction()).rejects.toThrow('REDIRECT:https://withpersona.com/verify?code=abc');
    expect(startVerification).toHaveBeenCalledTimes(1);
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycReviewState).toBe('inquiry_started');
    expect(c?.kycInquiryId).toBe('inq_1');
    expect(c?.kycSubmittedAt).toBeTruthy();
    expect((await kcs.getAudit(PHONE)).at(-1)).toMatchObject({ action: 'kyc.start' });
  });

  it('gate off: redirects to /account WITHOUT creating a Persona inquiry or recording anything', async () => {
    await setGate(false);
    await expect(startVerificationAction()).rejects.toThrow('REDIRECT:/account');
    expect(startVerification).not.toHaveBeenCalled();
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycReviewState).toBeUndefined();
    expect(c?.kycInquiryId).toBeUndefined();
    expect(await kcs.getAudit(PHONE)).toEqual([]);
  });
});
