import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createCustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import type { Store } from '@/lib/store';
import type { Customer } from '@/lib/types';

const redis = fakeRedis();
const cs = createCustomerStore(redis, {} as unknown as Store);
let seq = 0;
const store = createKycCaseStore(redis, cs, () => 1_700_000_000_000 + seq++); // monotonic clock
const PHONE = '15551230000';

const seed = (over: Partial<Customer> = {}) =>
  cs.saveCustomer({
    senderPhone: PHONE,
    firstSeenAt: '2026-06-01T00:00:00Z',
    kycStatus: 'pending',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Customer);

beforeEach(() => { redis.dump.clear(); seq = 0; });

describe('kyc-case-store', () => {
  it('markEventSeen is true once, false on replay (idempotency)', async () => {
    expect(await store.markEventSeen('evt_1')).toBe(true);
    expect(await store.markEventSeen('evt_1')).toBe(false);
  });

  it('applyDelta merges fields + appends an audit entry', async () => {
    await seed();
    await store.applyDelta(PHONE, { kycReviewState: 'pending_review', idLast4: '6789', kycInquiryId: 'inq_1' }, { actor: 'persona', action: 'inquiry.completed' });
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycReviewState).toBe('pending_review');
    expect(c?.idLast4).toBe('6789');
    expect(c?.kycInquiryId).toBe('inq_1');
    const audit = await store.getAudit(PHONE);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'persona', action: 'inquiry.completed' });
  });

  it('applyDelta returns null for an unknown customer', async () => {
    expect(await store.applyDelta('nope', { kycReviewState: 'needs_review' }, { actor: 'x', action: 'y' })).toBeNull();
  });

  it('review(approve) sets verified + approver + audit', async () => {
    await seed({ kycReviewState: 'pending_review' });
    await store.review(PHONE, 'approve', 'admin', 'docs look good');
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycStatus).toBe('verified');
    expect(c?.kycReviewState).toBe('approved');
    expect(c?.kycApprovedBy).toBe('admin');
    expect(c?.kycVerifiedAt).toBeTruthy();
    expect((await store.getAudit(PHONE)).at(-1)).toMatchObject({ action: 'review.approve', reason: 'docs look good' });
  });

  it('review(reject) sets rejected + reason', async () => {
    await seed({ kycReviewState: 'needs_review' });
    await store.review(PHONE, 'reject', 'admin', 'watchlist confirmed');
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycStatus).toBe('rejected');
    expect(c?.kycReviewState).toBe('rejected');
    expect(c?.kycRejectedReason).toBe('watchlist confirmed');
    expect(c?.kycRejectedAt).toBeTruthy();
  });

  it('listNeedsReview returns only pending_review/needs_review customers', async () => {
    await seed({ kycReviewState: 'pending_review' });
    await cs.saveCustomer({ senderPhone: '15550000001', firstSeenAt: '', kycStatus: 'verified', kycReviewState: 'approved', senderCountry: 'US', partnerId: 'default', createdAt: '', updatedAt: '' } as Customer);
    const list = await store.listNeedsReview();
    expect(list.map((c) => c.senderPhone)).toEqual([PHONE]);
  });

  it('listNeedsReview ignores customers with no kycReviewState (legacy/grandfathered)', async () => {
    await seed({ kycReviewState: undefined });
    expect(await store.listNeedsReview()).toHaveLength(0);
  });
});
