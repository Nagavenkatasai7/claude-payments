import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createCustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import type { Store } from '@/lib/store';
import type { Customer } from '@/lib/types';

const PHONE = '15551230000';
const redis = fakeRedis();
const cs = createCustomerStore(redis, {} as unknown as Store);
const kcs = createKycCaseStore(redis, cs);

const customer = { senderPhone: PHONE, firstSeenAt: '', kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: '', updatedAt: '' } as Customer;

vi.mock('@/lib/customer-auth', () => ({ requireCustomer: async () => customer }));
vi.mock('@/lib/store', () => ({ getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig() as object), getCustomerStore: () => cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...(await orig() as object), getKycCaseStore: () => kcs }));
vi.mock('@/lib/providers/kyc-provider', () => ({
  getKycProvider: () => ({
    startVerification: vi.fn(async () => ({ url: 'https://withpersona.com/verify?code=abc', providerRef: 'inq_1' })),
  }),
}));
vi.mock('next/navigation', () => ({ redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); } }));

import { startVerificationAction } from '@/app/account/verify/actions';

beforeEach(async () => { redis.dump.clear(); await cs.saveCustomer(customer); });

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
