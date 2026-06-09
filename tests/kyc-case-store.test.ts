import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore, type KycCaseStore } from '@/lib/kyc-case-store';
import { createStore } from '@/lib/store';
import type { Customer } from '@/lib/types';

// Customers live in Postgres now (PGlite per test); the audit hash + event
// dedup stay on Redis (fakeRedis) — those assertions are unchanged.
let redis: FakeRedis;
let cs: CustomerStore;
let store: KycCaseStore;
let seq = 0;
const PHONE = '15551230000';

const seed = (over: Partial<Customer> = {}) =>
  cs.saveCustomer({
    senderPhone: PHONE,
    firstSeenAt: '2026-06-01T00:00:00.000Z',
    kycStatus: 'pending',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  } as Customer);

beforeEach(async () => {
  const db = await freshDb();
  redis = fakeRedis();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  seq = 0;
  store = createKycCaseStore(redis, cs, () => 1_700_000_000_000 + seq++); // monotonic clock
});

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
    await cs.saveCustomer({ senderPhone: '15550000001', firstSeenAt: '2026-06-01T00:00:00.000Z', kycStatus: 'verified', kycReviewState: 'approved', senderCountry: 'US', partnerId: 'default', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' } as Customer);
    const list = await store.listNeedsReview();
    expect(list.map((c) => c.senderPhone)).toEqual([PHONE]);
  });

  it('listNeedsReview ignores customers with no kycReviewState (legacy/grandfathered)', async () => {
    await seed({ kycReviewState: undefined });
    expect(await store.listNeedsReview()).toHaveLength(0);
  });

  it('getAudit returns [] for a customer with no audit log', async () => {
    expect(await store.getAudit('15559990000')).toEqual([]);
  });

  it('getAudit parses the FLAT-ARRAY hgetall reply (real Upstash, automaticDeserialization:false)', async () => {
    // With automaticDeserialization:false, Upstash returns HGETALL as a flat
    // [field0, value0, field1, value1, ...] array — NOT a {field: value} object.
    // getAudit must parse only the VALUE slots and skip the field-name strings
    // (field names like "2026-06-02T22:52:44.740Z#000000" are not valid JSON).
    const arrayRedis = {
      async hgetall() {
        return [
          '2026-06-02T22:52:44.740Z#000000',
          JSON.stringify({ actor: 'persona', action: 'inquiry.created', at: '2026-06-02T22:52:44.740Z' }),
          '2026-06-02T22:52:45.000Z#000001',
          JSON.stringify({ actor: 'admin', action: 'review.approve', reason: 'ok', at: '2026-06-02T22:52:45.000Z' }),
        ];
      },
    } as unknown as Parameters<typeof createKycCaseStore>[0];
    const s = createKycCaseStore(arrayRedis, cs);
    const audit = await s.getAudit(PHONE);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor: 'persona', action: 'inquiry.created' });
    expect(audit[1]).toMatchObject({ actor: 'admin', action: 'review.approve', reason: 'ok' });
  });

  it('getAudit tolerates a corrupt/partial entry instead of throwing (degrades gracefully)', async () => {
    const arrayRedis = {
      async hgetall() {
        return [
          '2026-06-02T22:52:44.740Z#000000',
          '{ broken json',
          '2026-06-02T22:52:45.000Z#000001',
          JSON.stringify({ actor: 'admin', action: 'review.approve', at: '2026-06-02T22:52:45.000Z' }),
        ];
      },
    } as unknown as Parameters<typeof createKycCaseStore>[0];
    const s = createKycCaseStore(arrayRedis, cs);
    const audit = await s.getAudit(PHONE);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'admin', action: 'review.approve' });
  });
});
