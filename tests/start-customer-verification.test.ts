import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Store } from '@/lib/store';
import type { Customer } from '@/lib/types';

// UI redesign M2-11, Task 11.2: the ONE identity-verification start, shared by the legacy
// /account/verify action and the customer portal. Extracted verbatim: the partner's opt-in gate, the
// provider start, the kyc.start delta; only the audit actor is a parameter. The core does NOT decide
// 'delegated' (the portal checks that before calling it), so the legacy path is byte-identical.

const PHONE = '15551230000';
let cs: CustomerStore;
let kcs: ReturnType<typeof createKycCaseStore>;
let ps: PartnerStore;

const customer = { senderPhone: PHONE, firstSeenAt: '2026-01-01T00:00:00.000Z', kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as Customer;

const startVerification = vi.hoisted(() => vi.fn(async () => ({ url: 'https://kyc.example.com/verify?code=abc', providerRef: 'inq_1' })));

vi.mock('@/lib/customer-auth', () => ({ requireCustomer: async () => customer }));
vi.mock('@/lib/store', async (orig) => ({ ...((await orig()) as object), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...((await orig()) as object), getCustomerStore: () => cs }));
vi.mock('@/lib/kyc-case-store', async (orig) => ({ ...((await orig()) as object), getKycCaseStore: () => kcs }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...((await orig()) as object), getPartnerStore: () => ps }));
vi.mock('@/lib/providers/kyc-provider', () => ({ getKycProvider: () => ({ startVerification }) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`REDIRECT:${p}`);
  },
}));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

import { startCustomerVerification } from '@/lib/customer-verification';
import { startVerificationAction } from '@/app/account/verify/actions';

async function setPartner(patch: { requireKycBeforeSend: boolean; kycMode?: 'ours' | 'delegated' }): Promise<void> {
  const dflt = await ps.ensureDefaultPartner();
  await ps.savePartner({ ...dflt, ...patch, updatedAt: new Date().toISOString() });
}

beforeEach(async () => {
  startVerification.mockClear();
  const db = await freshDb();
  cs = createCustomerStore(db, { firstTransferAt: async () => null } as unknown as Store);
  kcs = createKycCaseStore(fakeRedis(), cs);
  ps = createPartnerStore(db);
  await cs.saveCustomer(customer);
  await setPartner({ requireKycBeforeSend: true });
});

describe('startCustomerVerification', () => {
  it('gate on → the provider start, inquiry_started recorded under the GIVEN actor, the hosted-flow URL returned', async () => {
    expect(await startCustomerVerification(customer, { actor: 'system:customer-portal' })).toEqual({
      kind: 'redirect',
      url: 'https://kyc.example.com/verify?code=abc',
    });
    expect(startVerification).toHaveBeenCalledWith({ customerId: PHONE, senderPhone: PHONE });
    const c = await cs.getCustomer('default', PHONE);
    expect(c).toMatchObject({ kycReviewState: 'inquiry_started', kycInquiryId: 'inq_1', kycProviderRef: 'inq_1' });
    expect((await kcs.getAudit('default', PHONE)).at(-1)).toMatchObject({ action: 'kyc.start', actor: 'system:customer-portal' });
  });

  it('gate off → gate_off, the provider is never touched and nothing is recorded', async () => {
    await setPartner({ requireKycBeforeSend: false });
    expect(await startCustomerVerification(customer, { actor: 'x' })).toEqual({ kind: 'gate_off' });
    expect(startVerification).not.toHaveBeenCalled();
    expect(await kcs.getAudit('default', PHONE)).toEqual([]);
  });

  it("legacy parity pin: a 'delegated' partner with the gate on still starts through the legacy action (unchanged)", async () => {
    await setPartner({ requireKycBeforeSend: true, kycMode: 'delegated' });
    await expect(startVerificationAction()).rejects.toThrow('REDIRECT:https://kyc.example.com/verify?code=abc');
    expect(startVerification).toHaveBeenCalledTimes(1);
    expect((await kcs.getAudit('default', PHONE)).at(-1)).toMatchObject({ action: 'kyc.start', actor: PHONE });
  });
});
