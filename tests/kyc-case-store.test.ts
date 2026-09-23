import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, captureQueries } from './helpers-db';
import { auditSubjectId } from '@/lib/customer-ref';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore, mergeKycTrail, type KycCaseStore } from '@/lib/kyc-case-store';
import { createStore } from '@/lib/store';
import type { Customer } from '@/lib/types';
import type { Db } from '@/db/client';

// Customers live in Postgres now (PGlite per test); the audit hash + event
// dedup stay on Redis (fakeRedis) — those assertions are unchanged.
let db: Db;
let redis: FakeRedis;
let cs: CustomerStore;
let store: KycCaseStore;
let seq = 0;
const PHONE = '15551230000';

// Program-Fix 28: the real audit repo with a switch that forces its insert to
// fail (the customer write must roll back with it). Off by default.
let failAudit = false;
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (dbx: Parameters<typeof real.createAuditRepo>[0]) => {
      const r = real.createAuditRepo(dbx);
      return {
        ...r,
        record: async (e: Parameters<typeof r.record>[0]) => {
          if (failAudit) throw new Error('audit insert failed');
          return r.record(e);
        },
      };
    },
  };
});

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
  db = await freshDb();
  redis = fakeRedis();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  seq = 0;
  failAudit = false;
  store = createKycCaseStore(redis, cs, () => 1_700_000_000_000 + seq++); // monotonic clock
});

describe('kyc-case-store', () => {
  it('markEventSeen is true once, false on replay (idempotency)', async () => {
    expect(await store.markEventSeen('evt_1')).toBe(true);
    expect(await store.markEventSeen('evt_1')).toBe(false);
  });

  it('applyDelta merges fields + appends an audit entry', async () => {
    await seed();
    await store.applyDelta('default', PHONE, { kycReviewState: 'pending_review', idLast4: '6789', kycInquiryId: 'inq_1' }, { actor: 'persona', action: 'inquiry.completed' });
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycReviewState).toBe('pending_review');
    expect(c?.idLast4).toBe('6789');
    expect(c?.kycInquiryId).toBe('inq_1');
    const audit = await store.getAudit('default', PHONE);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'persona', action: 'inquiry.completed' });
  });

  it('applyDelta returns null for an unknown customer', async () => {
    expect(await store.applyDelta('default', 'nope', { kycReviewState: 'needs_review' }, { actor: 'x', action: 'y' })).toBeNull();
  });

  it('review(approve) sets verified + approver + audit', async () => {
    await seed({ kycReviewState: 'pending_review' });
    await store.review('default', PHONE, 'approve', 'admin', 'docs look good');
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycStatus).toBe('verified');
    expect(c?.kycReviewState).toBe('approved');
    expect(c?.kycApprovedBy).toBe('admin');
    expect(c?.kycVerifiedAt).toBeTruthy();
    expect((await store.getAudit('default', PHONE)).at(-1)).toMatchObject({ action: 'review.approve', reason: 'docs look good' });
  });

  it('review(reject) sets rejected + reason', async () => {
    await seed({ kycReviewState: 'needs_review' });
    await store.review('default', PHONE, 'reject', 'admin', 'watchlist confirmed');
    const c = await cs.getCustomer('default', PHONE);
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
    expect(await store.getAudit('default', '15559990000')).toEqual([]);
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
    const audit = await s.getAudit('default', PHONE);
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
    const audit = await s.getAudit('default', PHONE);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'admin', action: 'review.approve' });
  });

  it('applyDelta / review / audit are tenant-scoped: acme cannot move the default row and audit trails never cross tenants', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme'); // the file's own handle, exactly as the D10 test below — never a second freshDb() (it re-truncates the singleton the beforeEach just seeded)
    await seed();
    expect(await store.applyDelta('acme', PHONE, { kycReviewState: 'approved' }, { actor: 'x', action: 'a' })).toBeNull();
    expect((await cs.getCustomer('default', PHONE))!.kycReviewState).toBeUndefined();
    await store.review('default', PHONE, 'approve', 'staff-1', 'ok');
    expect((await store.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['review.approve']);
    expect(await store.getAudit('acme', PHONE)).toEqual([]);
  });

  it('D10: a legacy phone-only audit trail is visible to the pre-fix (oldest-row) tenant and to NO sibling', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    await seed(); // the default row (older)
    await cs.upsertOnFirstInbound('acme', PHONE); // the post-fix sibling
    await redis.hset(`kyc_audit:${PHONE}`, { '1': JSON.stringify({ at: '2026-01-01T00:00:00Z', actor: 'persona', action: 'legacy.event' }) });
    expect((await store.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['legacy.event']);
    expect(await store.getAudit('acme', PHONE)).toEqual([]);
  });
});

// ── Program-Fix 28 (compliance-03): the durable KYC decision. With `db`, the
// lock, the customer write and the audit_events row are ONE transaction; the
// Redis entry follows the commit (tagged durable, best-effort).
describe('kyc-case-store.review with a db (Program-Fix 28)', () => {
  type Row = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
  async function auditRows(): Promise<Row[]> {
    const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
    return (r as unknown as { rows: Row[] }).rows;
  }
  const opts = () => ({ db, store: createStore(fakeRedis(), db), actor: 'plat', slug: 'kyc.review.approve', source: 'persona_review' as const });

  it('approve: customer verified + ONE audit row keyed on auditSubjectId (never the phone), actor = username, display name in meta', async () => {
    await seed({ kycReviewState: 'pending_review' });
    await store.review('default', PHONE, 'approve', 'Platform Admin (plat)', 'docs look good', opts());
    const c = await cs.getCustomer('default', PHONE);
    expect(c?.kycStatus).toBe('verified');
    expect(c?.kycApprovedBy).toBe('Platform Admin (plat)');
    const rows = await auditRows();
    expect(rows).toEqual([{
      partner_id: 'default', actor: 'plat', actor_type: 'staff', action: 'kyc.review.approve',
      subject_id: auditSubjectId('default', PHONE),
      meta: { previousStatus: 'pending', newStatus: 'verified', reason: 'docs look good', source: 'persona_review', reviewerName: 'Platform Admin (plat)' },
    }]);
    expect(JSON.stringify(rows)).not.toContain(PHONE);
  });

  it('the Redis entry follows the commit, tagged durable: true (the page skips it; the old build still shows it)', async () => {
    await seed({ kycReviewState: 'pending_review' });
    await store.review('default', PHONE, 'approve', 'Platform Admin (plat)', 'docs look good', opts());
    expect((await store.getAudit('default', PHONE)).at(-1)).toMatchObject({ action: 'review.approve', reason: 'docs look good', durable: true });
  });

  it('r2 red test: PII (fullName, DOB, govId, address) survives a review({db}) round-trip unchanged', async () => {
    await seed({
      kycReviewState: 'pending_review', fullName: 'Asha Example', dateOfBirth: '1990-01-02',
      govIdType: 'passport', govIdNumber: 'P1234567', residentialAddress: '1 Main St, Springfield',
    });
    await store.review('default', PHONE, 'reject', 'Platform Admin (plat)', 'document mismatch', { ...opts(), slug: 'kyc.review.reject' });
    const c = await cs.getCustomer('default', PHONE);
    expect(c).toMatchObject({
      kycStatus: 'rejected', fullName: 'Asha Example', dateOfBirth: '1990-01-02',
      govIdType: 'passport', govIdNumber: 'P1234567', residentialAddress: '1 Main St, Springfield',
    });
  });

  it('locks the tenant row FOR UPDATE before the tx-bound read (lock-only SELECT 1)', async () => {
    await seed({ kycReviewState: 'pending_review' });
    const stop = captureQueries();
    await store.review('default', PHONE, 'approve', 'plat', 'docs look good', opts());
    const q = stop().map((x) => x.sql.toLowerCase());
    const lock = q.findIndex((x) => x.includes('for update') && x.includes('"customers"'));
    const read = q.findIndex((x, i) => i > lock && x.startsWith('select') && x.includes('"customers"'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(q[lock]).toMatch(/select 1/);
    expect(read).toBeGreaterThan(lock);
  });

  it('a failing audit insert rolls the decision back: status unchanged, no Redis entry', async () => {
    await seed({ kycReviewState: 'pending_review' });
    failAudit = true;
    await expect(store.review('default', PHONE, 'approve', 'plat', 'docs look good', opts())).rejects.toThrow('audit insert failed');
    expect((await cs.getCustomer('default', PHONE))?.kycStatus).toBe('pending');
    expect(await store.getAudit('default', PHONE)).toEqual([]);
  });

  it('r2: a Redis failure AFTER commit is swallowed — the decision and its single audit row stand', async () => {
    await seed({ kycReviewState: 'pending_review' });
    const broken = { ...redis, hset: async () => { throw new Error('redis down'); }, hgetall: async () => { throw new Error('redis down'); } } as unknown as FakeRedis;
    const s = createKycCaseStore(broken, cs);
    const out = await s.review('default', PHONE, 'approve', 'plat', 'docs look good', opts());
    expect(out?.kycStatus).toBe('verified');
    expect((await cs.getCustomer('default', PHONE))?.kycStatus).toBe('verified');
    expect(await auditRows()).toHaveLength(1);
  });

  it('an unknown customer ⇒ null, nothing written', async () => {
    expect(await store.review('default', '15550000009', 'approve', 'plat', 'docs look good', opts())).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('a tenant mismatch never touches the other tenant\'s row', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    await seed({ kycReviewState: 'pending_review' });
    expect(await store.review('acme', PHONE, 'approve', 'plat', 'docs look good', opts())).toBeNull();
    expect((await cs.getCustomer('default', PHONE))?.kycStatus).toBe('pending');
    expect(await auditRows()).toEqual([]);
  });
});

describe('mergeKycTrail — the page trail (Program-Fix 28)', () => {
  it('durable rows + legacy Redis entries NOT tagged durable, oldest first; the display name wins over the username', () => {
    const merged = mergeKycTrail(
      [
        { actor: 'plat', action: 'kyc.manual_override.approve', at: '2026-09-23T10:00:00.000Z', meta: { reason: 'docs checked offline', reviewerName: 'Platform Admin (plat)' } },
        { actor: 'plat', action: 'kyc.review.reject', at: '2026-09-22T10:00:00.000Z', meta: { reason: 'blurry id' } },
      ],
      [
        { actor: 'persona', action: 'inquiry.completed', at: '2026-09-21T10:00:00.000Z' },
        { actor: 'Platform Admin (plat)', action: 'review.approve', at: '2026-09-23T10:00:00.001Z', reason: 'docs checked offline', durable: true },
      ],
    );
    expect(merged).toEqual([
      { actor: 'persona', action: 'inquiry.completed', at: '2026-09-21T10:00:00.000Z', reason: undefined },
      { actor: 'plat', action: 'kyc.review.reject', at: '2026-09-22T10:00:00.000Z', reason: 'blurry id' },
      { actor: 'Platform Admin (plat)', action: 'kyc.manual_override.approve', at: '2026-09-23T10:00:00.000Z', reason: 'docs checked offline' },
    ]);
  });

  it('a non-string meta.reason / reviewerName is ignored, never rendered as [object Object]', () => {
    expect(mergeKycTrail([{ actor: 'plat', action: 'kyc.review.approve', at: '2026-09-23T10:00:00.000Z', meta: { reason: { x: 1 }, reviewerName: 7 } }], [])).toEqual([
      { actor: 'plat', action: 'kyc.review.approve', at: '2026-09-23T10:00:00.000Z', reason: undefined },
    ]);
  });
});
