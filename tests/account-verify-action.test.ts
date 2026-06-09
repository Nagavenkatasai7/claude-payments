import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import type { Store } from '@/lib/store';
import type { Customer } from '@/lib/types';

const PHONE = '15551230000';
const redis = fakeRedis();
// pg-backed stores are rebuilt per test in beforeEach (freshDb truncates) —
// the hoisted vi.mock factories below only dereference these at call time.
let cs: CustomerStore;
let kcs: ReturnType<typeof createKycCaseStore>;

const customer = { senderPhone: PHONE, firstSeenAt: '2026-01-01T00:00:00.000Z', kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as Customer;

vi.mock('@/lib/customer-auth', () => ({ requireCustomer: async () => customer }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig() as object), getCustomerStore: () => cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig() as object), getKycCaseStore: () => kcs }));
vi.mock('@/lib/providers/kyc-provider', () => ({
  getKycProvider: () => ({
    startVerification: vi.fn(async () => ({ url: 'https://withpersona.com/verify?code=abc', providerRef: 'inq_1' })),
  }),
}));
vi.mock('next/navigation', () => ({ redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); } }));

import { startVerificationAction } from '@/app/account/verify/actions';

beforeEach(async () => {
  redis.dump.clear();
  const db = await freshDb();
  cs = createCustomerStore(db, { firstTransferAt: async () => null } as unknown as Store);
  kcs = createKycCaseStore(redis, cs);
  await cs.saveCustomer(customer);
});

describe('startVerificationAction', () => {
  it('starts an inquiry, records inquiry_started, redirects to the hosted-flow URL', async () => {
    await expect(startVerificationAction()).rejects.toThrow('REDIRECT:https://withpersona.com/verify?code=abc');
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycReviewState).toBe('inquiry_started');
    expect(c?.kycInquiryId).toBe('inq_1');
    expect(c?.kycSubmittedAt).toBeTruthy();
    expect((await kcs.getAudit(PHONE)).at(-1)).toMatchObject({ action: 'kyc.start' });
  });
});
