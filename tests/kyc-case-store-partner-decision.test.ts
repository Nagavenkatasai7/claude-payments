// Fix pack 7 (T25; P22 bullet 3, P23): kyc-case-store.review's three optional options for a
// partner that decides KYC: extraMeta (closed keys merged into the decision's audit meta),
// pepClear (an approve clears a PEP-only flag in the SAME locked transaction through
// clearPepInTx; refused when the locked row changed) and pepClearable (the locked re-check
// treats an already-cleared PEP-only hit as no hold). Every option absent = today.
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis, type FakeRedis } from './helpers';
import { freshDb, captureQueries, seedPartner } from './helpers-db';
import { auditSubjectId } from '@/lib/customer-ref';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createKycCaseStore, type DurableReviewOpts, type KycCaseStore } from '@/lib/kyc-case-store';
import { KycScreeningChangedError } from '@/lib/sender-screening';
import { createStore } from '@/lib/store';
import type { Customer } from '@/lib/types';
import type { Db } from '@/db/client';

let db: Db;
let redis: FakeRedis;
let cs: CustomerStore;
let store: KycCaseStore;
const PHONE = '15551230000';
const REFUSAL = 'You do not have permission to perform this action.';

type Row = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> };
async function audit(): Promise<Row[]> {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: Row[] }).rows;
}
type Flags = { pep_hit: boolean | null; watchlist_hit: boolean | null; screening_flagged_at: Date | null; screening_cleared_at: Date | null; kyc_status: string };
async function flagsOf(partnerId = 'default'): Promise<Flags> {
  const r = await db.execute(sql`SELECT pep_hit, watchlist_hit, screening_flagged_at, screening_cleared_at, kyc_status FROM customers WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
  return (r as unknown as { rows: Flags[] }).rows[0];
}

const seed = (partnerId = 'default', over: Partial<Customer> = {}) =>
  cs.saveCustomer({
    senderPhone: PHONE,
    firstSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
    kycStatus: 'pending',
    kycReviewState: 'needs_review',
    senderCountry: 'US',
    partnerId,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    ...over,
  } as Customer);

/** Sets the flag columns by SQL (relative times, minutes from now; null = NULL). */
async function setFlags(
  f: { pep?: boolean | null; watchlist?: boolean | null; flaggedMin?: number | null; clearedMin?: number | null; watchlistMin?: number | null },
  partnerId = 'default',
): Promise<Date | null> {
  const base = Date.now();
  const at = (m: number | null | undefined) => (m === null || m === undefined ? null : new Date(base + m * 60_000));
  const flagged = at(f.flaggedMin);
  await db.execute(sql`UPDATE customers SET pep_hit = ${f.pep ?? null}, watchlist_hit = ${f.watchlist ?? null},
    screening_flagged_at = ${flagged}, screening_cleared_at = ${at(f.clearedMin)},
    screening_watchlist_at = ${at(f.watchlistMin)}
    WHERE partner_id = ${partnerId} AND phone = ${PHONE}`);
  return flagged;
}

const opts = (over: Partial<DurableReviewOpts> = {}): DurableReviewOpts => ({
  db,
  store: createStore(fakeRedis(), db),
  actor: 'pcomp',
  slug: 'kyc.review.approve',
  source: 'manual',
  actorScope: 'partner',
  ...over,
});
const BASE_META = (prev: string, next: string, reason: string) => ({
  previousStatus: prev,
  newStatus: next,
  reason,
  source: 'manual',
  reviewerName: 'Partner Comp (pcomp)',
  actorScope: 'partner',
});

beforeEach(async () => {
  db = await freshDb();
  redis = fakeRedis();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  store = createKycCaseStore(redis, cs);
});

describe('kyc-case-store.review extraMeta (P22)', () => {
  it('extraMeta { disposition, eddDone, eddNote } on an approve: the meta is today\'s keys plus exactly those three', async () => {
    await seed();
    await store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      extraMeta: { disposition: 'false_positive', eddDone: true, eddNote: 'Source of wealth confirmed' },
    }));
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({
      ...BASE_META('pending', 'verified', 'docs look good'),
      disposition: 'false_positive',
      eddDone: true,
      eddNote: 'Source of wealth confirmed',
    });
  });

  it.each([
    ['an unknown key', { disposition: 'false_positive', bogus: 'x' }, { disposition: 'false_positive' }],
    ['a 300-char note', { eddDone: true, eddNote: 'a'.repeat(300) }, { eddDone: true }],
    ['a 12-digit run in the note', { eddDone: true, eddNote: 'acct 123456789012 checked' }, { eddDone: true }],
    ['disposition approve', { disposition: 'approve', eddDone: true }, { eddDone: true }],
  ])('extraMeta with %s: the invalid parts are dropped; the decision still commits', async (_n, raw, kept) => {
    await seed();
    const out = await store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      extraMeta: raw as unknown as DurableReviewOpts['extraMeta'],
    }));
    expect(out?.kycStatus).toBe('verified');
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ ...BASE_META('pending', 'verified', 'docs look good'), ...kept });
  });

  it.each([['absent', undefined], ['{}', {}]])('extraMeta %s: the meta is deep-equal to a decision with no new option (golden)', async (_n, extra) => {
    await seed();
    const o = opts();
    if (extra !== undefined) o.extraMeta = extra;
    await store.review('default', PHONE, 'reject', 'Partner Comp (pcomp)', 'document mismatch', { ...o, slug: 'kyc.review.reject' });
    const rows = await audit();
    expect(rows).toEqual([{
      partner_id: 'default', actor: 'pcomp', actor_type: 'staff', action: 'kyc.review.reject',
      subject_id: auditSubjectId('default', PHONE),
      meta: BASE_META('pending', 'rejected', 'document mismatch'),
    }]);
  });
});

describe('kyc-case-store.review pepClear (P22, P23)', () => {
  it('approve of a PEP-only customer at the posted flag time: verified, cleared, the clear row then the decision row', async () => {
    await seed();
    const flagged = await setFlags({ pep: true, flaggedMin: -10 });
    const out = await store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      allowScreeningHold: true,
      pepClear: { reviewedFlaggedAt: flagged!.toISOString() },
      extraMeta: { disposition: 'false_positive' },
    }));
    expect(out?.kycStatus).toBe('verified');
    const f = await flagsOf();
    expect(f.kyc_status).toBe('verified');
    expect(f.screening_cleared_at).not.toBeNull();
    expect(new Date(f.screening_cleared_at!).getTime()).toBeGreaterThan(new Date(f.screening_flagged_at!).getTime());
    const rows = await audit();
    expect(rows.map((r) => r.action)).toEqual(['customer.screening_hold.clear', 'kyc.review.approve']);
    expect(rows[0].meta).toMatchObject({ via: 'kyc_decision', actorScope: 'partner', pepHit: true, watchlistHit: false });
    expect(rows[0].meta).not.toHaveProperty('reason');
    expect(rows[0].subject_id).toBe(auditSubjectId('default', PHONE));
    expect(rows[1].meta).toEqual({ ...BASE_META('pending', 'verified', 'docs look good'), disposition: 'false_positive' });
    expect(JSON.stringify(rows)).not.toContain(PHONE);
  });

  it('a watchlist hit on the locked row (set after the caller\'s read): KycScreeningChangedError, nothing written', async () => {
    await seed();
    const flagged = await setFlags({ pep: true, flaggedMin: -10 });
    const posted = flagged!.toISOString();
    await db.execute(sql`UPDATE customers SET watchlist_hit = true WHERE partner_id = 'default' AND phone = ${PHONE}`);
    const before = await flagsOf();
    await expect(store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      allowScreeningHold: true, pepClear: { reviewedFlaggedAt: posted },
    }))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect(await flagsOf()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(await store.getAudit('default', PHONE)).toEqual([]);
  });

  it('a watchlist stamp newer than the last clear on the locked row: KycScreeningChangedError', async () => {
    await seed();
    const flagged = await setFlags({ pep: true, flaggedMin: -10, watchlistMin: -10 });
    await expect(store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      allowScreeningHold: true, pepClear: { reviewedFlaggedAt: flagged!.toISOString() },
    }))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect(await audit()).toEqual([]);
  });

  it.each([
    ['a newer match landed', (d: Date) => new Date(d.getTime() - 60_000).toISOString()],
    ['an empty posted time', () => ''],
    ['an unreadable posted time', () => 'not-a-time'],
  ])('reviewedFlaggedAt differs from the locked flag time (%s): KycScreeningChangedError, nothing written', async (_n, posted) => {
    await seed();
    const flagged = await setFlags({ pep: true, flaggedMin: -10 });
    const before = await flagsOf();
    await expect(store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      allowScreeningHold: true, pepClear: { reviewedFlaggedAt: posted(flagged!) },
    }))).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect(await flagsOf()).toEqual(before);
    expect(await audit()).toEqual([]);
    expect(await store.getAudit('default', PHONE)).toEqual([]);
  });

  it('a reject with pepClear re-checks (a watchlist hit refuses) but clears nothing', async () => {
    await seed();
    const flagged = await setFlags({ pep: true, flaggedMin: -10 });
    const o = opts({ slug: 'kyc.review.reject', allowScreeningHold: true, pepClear: { reviewedFlaggedAt: flagged!.toISOString() }, extraMeta: { disposition: 'reject' } });
    const out = await store.review('default', PHONE, 'reject', 'Partner Comp (pcomp)', 'document mismatch', o);
    expect(out?.kycStatus).toBe('rejected');
    const f = await flagsOf();
    expect(f.kyc_status).toBe('rejected');
    expect(f.screening_cleared_at).toBeNull();
    const rows = await audit();
    expect(rows.map((r) => r.action)).toEqual(['kyc.review.reject']);
    expect(rows[0].meta).toEqual({ ...BASE_META('pending', 'rejected', 'document mismatch'), disposition: 'reject' });

    // A second customer state: a watchlist hit lands; the reject's re-check refuses.
    await db.execute(sql`UPDATE customers SET kyc_status = 'pending', watchlist_hit = true WHERE partner_id = 'default' AND phone = ${PHONE}`);
    await expect(store.review('default', PHONE, 'reject', 'Partner Comp (pcomp)', 'document mismatch', o)).rejects.toBeInstanceOf(KycScreeningChangedError);
    expect(await audit()).toHaveLength(1);
  });

  it('a missing customer row: null (as today), nothing written', async () => {
    expect(await store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      allowScreeningHold: true, pepClear: { reviewedFlaggedAt: new Date(Date.now() - 60_000).toISOString() },
    }))).toBeNull();
    expect(await audit()).toEqual([]);
  });

  it('tenant: a pepClear on partner A never reads or clears partner B\'s same-phone row', async () => {
    await seedPartner(db, 'acme');
    await seed('default');
    const flagged = await setFlags({ pep: true, flaggedMin: -10 }, 'default');
    const before = await flagsOf('default');
    // acme has no row with this phone: null, the default row untouched.
    expect(await store.review('acme', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      allowScreeningHold: true, pepClear: { reviewedFlaggedAt: flagged!.toISOString() },
    }))).toBeNull();
    expect(await flagsOf('default')).toEqual(before);
    expect(await audit()).toEqual([]);
    // acme gets its own row (PEP-only, its own flag time): only acme's row is cleared.
    await seed('acme');
    const acmeFlagged = await setFlags({ pep: true, flaggedMin: -20 }, 'acme');
    const stop = captureQueries();
    await store.review('acme', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({
      allowScreeningHold: true, pepClear: { reviewedFlaggedAt: acmeFlagged!.toISOString() },
    }));
    const q = stop().map((x) => x.sql.toLowerCase()).filter((x) => x.includes('"customers"'));
    expect(q.length).toBeGreaterThan(0);
    for (const s of q) expect(s).toMatch(/"partner_id"/);
    expect(await flagsOf('default')).toEqual(before);
    expect((await flagsOf('acme')).screening_cleared_at).not.toBeNull();
    expect((await audit()).every((r) => r.partner_id === 'acme')).toBe(true);
  });
});

describe('kyc-case-store.review pepClearable (P22)', () => {
  it('a PEP-only hit cleared after its flag: refused without pepClearable (today\'s text), committed with it', async () => {
    await seed();
    await setFlags({ pep: true, flaggedMin: -10, clearedMin: -5 });
    await expect(store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({ allowScreeningHold: false })))
      .rejects.toThrow(REFUSAL);
    expect(await audit()).toEqual([]);
    const out = await store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({ allowScreeningHold: false, pepClearable: true }));
    expect(out?.kycStatus).toBe('verified');
    const rows = await audit();
    expect(rows.map((r) => r.action)).toEqual(['kyc.review.approve']);
    expect(rows[0].meta).toEqual(BASE_META('pending', 'verified', 'docs look good'));
  });

  it.each([
    ['a watchlist hit', { watchlist: true, flaggedMin: -10, clearedMin: -5 }],
    ['an uncleared PEP stamp', { pep: true, flaggedMin: -5, clearedMin: -10 }],
    ['an uncleared watchlist stamp', { pep: true, flaggedMin: -5, watchlistMin: -5, clearedMin: -10 }],
  ])('pepClearable does not let %s through: refused with today\'s text', async (_n, f) => {
    await seed();
    await setFlags(f);
    await expect(store.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good', opts({ allowScreeningHold: false, pepClearable: true })))
      .rejects.toThrow(REFUSAL);
    expect((await flagsOf()).kyc_status).toBe('pending');
    expect(await audit()).toEqual([]);
  });
});

describe('kyc-case-store.review legacy path (no db) ignores the new options', () => {
  it('no DB statement; the Redis trail as today', async () => {
    await seed();
    await setFlags({ pep: true, flaggedMin: -10 });
    const legacy = createKycCaseStore(redis, cs);
    const stop = captureQueries();
    // The legacy path takes no durable options at all: the type has no slot for them.
    const out = await legacy.review('default', PHONE, 'approve', 'Partner Comp (pcomp)', 'docs look good');
    const q = stop().map((x) => x.sql.toLowerCase());
    expect(out?.kycStatus).toBe('verified');
    expect(q.some((x) => x.includes('audit_events'))).toBe(false);
    expect(q.some((x) => x.includes('for update'))).toBe(false);
    expect((await flagsOf()).screening_cleared_at).toBeNull();
    expect((await store.getAudit('default', PHONE)).map((e) => e.action)).toEqual(['review.approve']);
  });
});
