import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore, type KycCaseStore } from '@/lib/kyc-case-store';
import { createStore } from '@/lib/store';
import type { Customer } from '@/lib/types';

// pg-backed stores rebuilt per test (freshDb truncates); the hoisted mock
// factories must NOT construct them — the getters close over the lets lazily.
let cs: CustomerStore;
let kcs: KycCaseStore;
const notify = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/auth', () => ({ requireAdmin: async () => ({ username: 'admin', name: 'Main Admin', role: 'admin' }), requireScope: async () => ({}) }));
vi.mock('@/lib/staff-scope', () => ({ scopeOf: () => 'platform', canSee: (_s: unknown, pid: string) => pid !== 'other' }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig() as object), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async (o) => ({ ...(await o() as object), getCustomerStore: () => cs }));
vi.mock('@/lib/kyc-case-store', async (o) => ({ ...(await o() as object), getKycCaseStore: () => kcs }));
vi.mock('@/lib/whatsapp', () => ({ sendVerificationStatus: notify }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { reviewKycAction } from '@/app/admin-dashboard/customers/actions';

const PHONE = '15551230000';
function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const ISO = '2026-06-01T00:00:00.000Z';
const seed = (over: Partial<Customer> = {}) =>
  cs.saveCustomer({ senderPhone: PHONE, firstSeenAt: ISO, kycStatus: 'pending', kycReviewState: 'pending_review', senderCountry: 'US', partnerId: 'default', createdAt: ISO, updatedAt: ISO, ...over } as Customer);

beforeEach(async () => {
  const db = await freshDb();
  await seedPartner(db, 'other'); // customers FK partners — needed for the out-of-scope test
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  kcs = createKycCaseStore(fakeRedis(), cs);
  notify.mockClear();
});

describe('reviewKycAction', () => {
  it('approve → verified + approver + audit + customer notified', async () => {
    await seed();
    await reviewKycAction(form({ phone: PHONE, decision: 'approve', reason: 'docs clean' }));
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycStatus).toBe('verified');
    expect(c?.kycReviewState).toBe('approved');
    expect(c?.kycApprovedBy).toBe('Main Admin (admin)'); // display name + stable username
    expect((await kcs.getAudit(PHONE)).at(-1)).toMatchObject({ action: 'review.approve', reason: 'docs clean' });
    expect(notify).toHaveBeenCalledWith(PHONE, 'verified', undefined);
  });

  it('reject → rejected + reason + customer notified', async () => {
    await seed({ kycReviewState: 'needs_review' });
    await reviewKycAction(form({ phone: PHONE, decision: 'reject', reason: 'watchlist confirmed' }));
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycStatus).toBe('rejected');
    expect(c?.kycRejectedReason).toBe('watchlist confirmed');
    expect(notify).toHaveBeenCalledWith(PHONE, 'failed', undefined);
  });

  it('requires a reason', async () => {
    await seed();
    await expect(reviewKycAction(form({ phone: PHONE, decision: 'approve', reason: '' }))).rejects.toThrow(/reason/i);
  });

  it('rejects an invalid decision', async () => {
    await seed();
    await expect(reviewKycAction(form({ phone: PHONE, decision: 'maybe', reason: 'x' }))).rejects.toThrow(/decision/i);
  });

  it('rejects an out-of-scope customer (partner boundary)', async () => {
    await seed({ partnerId: 'other' });
    await expect(reviewKycAction(form({ phone: PHONE, decision: 'approve', reason: 'x' }))).rejects.toThrow(/not found/i);
  });
});
