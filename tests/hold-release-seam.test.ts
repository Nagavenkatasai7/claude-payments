/**
 * Fix pack 7 T8a (P9 release half, P12 texts, P28): the release seam with a
 * review record. releaseHold / releaseHoldAfterRescreen / releaseTransfer take
 * an optional `review`; with it, ONE transaction: the tenant-pinned locked
 * read, the owner re-read, the row fingerprint, the locked sender flags, the
 * classes, decisionRoute and nextStep (expectFinal), identity / originator /
 * sender, the claim, THEN the hold_reviews row, THEN the audit. Every refusal
 * writes nothing (M5). recordHoldStep writes a non-moving step. Without a
 * review, a certified owner's live row is refused (D6).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedOriginatorForTest } from './helpers-live';
import { certifiedQueuePartner, heldRowFor } from './helpers-hold';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence } from './helpers-sanctions';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { beginHold, recordHoldStep, releaseHold } from '@/lib/settlement';
import {
  HOLD_CHANGED_REFUSAL, HOLD_REVIEW_RELOAD_REFUSAL, PARTNER_DECIDES_HOLD_REFUSAL, PLATFORM_RESCREEN_REFUSALS,
  releaseTransfer, SENDER_SCREENING_RELEASE_REFUSAL,
} from '@/lib/dashboard-ops';
import { HoldReviewChangedError, type HoldReviewInput } from '@/lib/hold-review-tx';
import { classReasonsFp, classifyHold, rowReasonsFp, type HoldClass, type HoldDisposition } from '@/lib/hold-queue';
import {
  LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, ORIGINATOR_INFO_MISSING_REASON, POSSIBLE_MATCH_REASON, SENDER_SCREENING_REASON,
} from '@/lib/compliance-config';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { auditSubjectId } from '@/lib/customer-ref';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { writeOriginatorInfo } from '@/lib/originator-info';
import { sweepListUnavailableHolds } from '@/lib/list-hold-rescreen';

vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => {} };
});

// The owner read (tests/partner-release-action.test.ts pattern): a switch on getPartner.
const ownerRead = vi.hoisted(() => ({ mode: 'real' as 'real' | 'throw' | 'null' }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const repo = real.createPartnerRepo(...a);
      return {
        ...repo,
        getPartner: async (...g: Parameters<typeof repo.getPartner>) => {
          if (ownerRead.mode === 'throw') throw new Error('owner read failed');
          if (ownerRead.mode === 'null') return null;
          return repo.getPartner(...g);
        },
      };
    },
  };
});

// The review insert: a switch that answers null (a unique index refused it).
const reviewInsert = vi.hoisted(() => ({ refuse: false }));
vi.mock('@/db/repos/hold-review-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/hold-review-repo')>();
  return {
    ...real,
    createHoldReviewRepo: (...a: Parameters<typeof real.createHoldReviewRepo>) => {
      const repo = real.createHoldReviewRepo(...a);
      return { ...repo, insert: async (...w: Parameters<typeof repo.insert>) => (reviewInsert.refuse ? null : repo.insert(...w)) };
    },
  };
});

const H = 3_600_000;
const REASON = 'Checked the documents on file for this hold.';
const REL = { actor: 'plat', reason: REASON };
const PARTNER_CHANGED = 'Cannot release: transfer is not in_review or its sender is not releasable (it changed concurrently)';

let db: Db;
let store: ReturnType<typeof createStore>;
const originalList = process.env.SANCTIONS_LIST;

beforeEach(async () => {
  ownerRead.mode = 'real';
  reviewInsert.refuse = false;
  db = await freshDb();
  store = createStore(fakeRedis(), db);
});
afterEach(() => {
  ownerRead.mode = 'real';
  reviewInsert.refuse = false;
  restoreOfacSource(originalList);
});

type Rows<T> = { rows: T[] };
async function count(table: 'hold_reviews' | 'audit_events' | 'outbox', id?: string): Promise<number> {
  const where =
    table === 'hold_reviews' ? sql`WHERE transfer_id = ${id ?? ''}` : table === 'audit_events' ? sql`WHERE subject_id = ${id ?? ''}` : sql``;
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} ${where}`)) as unknown as Rows<{ n: number }>;
  return r.rows[0].n;
}
async function snapshot(id: string) {
  return {
    status: (await store.getTransfer(id))?.status,
    reviews: await count('hold_reviews', id),
    audit: await count('audit_events', id),
    outbox: await count('outbox'),
  };
}
async function outboxKeys(): Promise<Array<string | null>> {
  const r = (await db.execute(sql`SELECT dedupe_key FROM outbox ORDER BY id`)) as unknown as Rows<{ dedupe_key: string | null }>;
  return r.rows.map((x) => x.dedupe_key);
}
type ReviewRow = { hold_class: string; step: number; final: boolean; disposition: string; actor_scope: string; partner_id: string; reasons_fp: string; actor: string; reason: string };
async function reviewRows(id: string): Promise<ReviewRow[]> {
  const r = (await db.execute(sql`SELECT * FROM hold_reviews WHERE transfer_id = ${id} ORDER BY created_at, step`)) as unknown as Rows<ReviewRow>;
  return r.rows;
}
type AuditRow = { actor: string; action: string; meta: Record<string, unknown> };
async function audits(id: string, action: string): Promise<AuditRow[]> {
  const r = (await db.execute(sql`SELECT actor, action, meta FROM audit_events WHERE subject_id = ${id} AND action = ${action} ORDER BY id`)) as unknown as Rows<AuditRow>;
  return r.rows;
}
async function setReasons(id: string, reasons: string[]): Promise<Transfer> {
  await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify(reasons)}::jsonb WHERE id = ${id}`);
  return (await store.getTransfer(id))!;
}
const rail = () => createIntegrationsRepo(db).getIntegrations('acme');
const delegated = () => certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });

function review(t: Transfer, holdClass: HoldClass, disposition: HoldDisposition, o: Partial<HoldReviewInput> = {}): HoldReviewInput {
  return {
    ownerId: t.partnerId, holdClass, rowFp: rowReasonsFp(t.complianceReasons), disposition, reason: REASON,
    actor: 'plat', actorScope: 'platform', evidence: {}, expectFinal: true, ...o,
  };
}
const partnerReview = (t: Transfer, actor: string, expectFinal: boolean, disposition: HoldDisposition = 'documents_verified') =>
  review(t, 'kyc', disposition, { actor, actorScope: 'partner', expectFinal });

describe('releaseTransfer without a review on a certified owner (D6)', { retry: 0 }, () => {
  it('1: certified delegated owner, platform: HOLD_REVIEW_RELOAD_REFUSAL; nothing written', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    await expect(releaseTransfer(store, db, t.id, REL)).rejects.toThrow(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await snapshot(t.id)).toEqual({ ...before, status: 'in_review' });
    expect(before.reviews).toBe(0);
  });

  it('2: queue owner, a kyc-class row, platform: PARTNER_DECIDES_HOLD_REFUSAL; nothing written', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    await expect(releaseTransfer(store, db, t.id, REL)).rejects.toThrow(PARTNER_DECIDES_HOLD_REFUSAL);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('3: partnerRelease on a certified owner: the existing partner concurrent text; nothing written', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    await expect(releaseTransfer(store, db, t.id, REL, { partnerId: 'acme' })).rejects.toThrow(PARTNER_CHANGED);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it("4: a sandbox ('test') row of a certified owner: released as today, no hold_reviews row", async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${t.id}`);
    ownerRead.mode = 'throw'; // its owner is not read at all
    await releaseTransfer(store, db, t.id, REL);
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect(await count('hold_reviews', t.id)).toBe(0);
  });

  it('5: the owner read throws: the error propagates, nothing written; it returns null: the permission text', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    ownerRead.mode = 'throw';
    await expect(releaseTransfer(store, db, t.id, REL)).rejects.toThrow('owner read failed');
    ownerRead.mode = 'null';
    await expect(releaseTransfer(store, db, t.id, REL)).rejects.toThrow('You do not have permission to perform this action.');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('the three P12 texts are fixed', () => {
    expect(PARTNER_DECIDES_HOLD_REFUSAL).toBe('The partner decides this hold: pause or escalate.');
    expect(HOLD_REVIEW_RELOAD_REFUSAL).toBe('This partner needs a recorded decision with a disposition: reload the page and decide again.');
    expect(HOLD_CHANGED_REFUSAL).toBe('This hold changed since the page loaded: reload the page and decide again.');
  });
});

describe('the release seam with a review (P9)', { retry: 0 }, () => {
  it('6: certified delegated owner, LARGE row on the simulator rail: released with ONE review row, ONE audit row, the instruct', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const integ = await rail();
    await createIntegrationsRepo(db).saveIntegrations('acme', { ...integ, payment: { ...integ.payment, providerType: 'simulator' } });
    const keysBefore = await outboxKeys();
    await releaseTransfer(store, db, t.id, REL, undefined, review(t, 'kyc', 'documents_verified'));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    const rows = await reviewRows(t.id);
    expect(rows).toHaveLength(1);
    const kyc = classifyHold(t.complianceReasons, undefined, { queue: false, partnerDecidesKyc: false })[0];
    expect(rows[0]).toMatchObject({
      hold_class: 'kyc', step: 1, final: true, disposition: 'documents_verified', actor_scope: 'platform', partner_id: 'acme',
      reasons_fp: classReasonsFp(kyc), actor: 'plat', reason: REASON,
    });
    const rel = await audits(t.id, 'transfer.release');
    expect(rel).toHaveLength(1);
    expect(rel[0].actor).toBe('plat');
    expect(rel[0].meta).toMatchObject({
      previousStatus: 'in_review', newStatus: 'paid', reviewId: expect.any(String), step: 1, disposition: 'documents_verified',
      holdClass: 'kyc', actorScope: 'platform', reason: REASON,
    });
    // T23 (P21): the certified owner's final review queues its hold.disposition event before the rail effect.
    expect((await outboxKeys()).slice(keysBefore.length)).toEqual([`hold.disposition:${rel[0].meta.reviewId as string}`, `instruct:${t.id}`]);
  });

  it('7: a lost claim (paid by SQL after the caller read the row): already; nothing written', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const rv = review(t, 'kyc', 'documents_verified');
    await db.execute(sql`UPDATE transfers SET status = 'paid' WHERE id = ${t.id}`);
    const before = await snapshot(t.id);
    expect(await releaseHold(db, t, await rail(), undefined, undefined, rv)).toEqual({ kind: 'already' });
    expect(await snapshot(t.id)).toEqual(before);
    expect(before.reviews).toBe(0);
  });

  it('8: a stale rowFp: releaseHold answers changed; releaseTransfer throws HoldReviewChangedError(changed); nothing written', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const rv = review(t, 'kyc', 'documents_verified', { rowFp: 'v1|stale' });
    const before = await snapshot(t.id);
    expect(await releaseHold(db, t, await rail(), undefined, undefined, rv)).toEqual({ kind: 'changed', why: 'changed' });
    const err = await releaseTransfer(store, db, t.id, REL, undefined, rv).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldReviewChangedError);
    expect((err as HoldReviewChangedError).why).toBe('changed');
    expect((err as Error).message.startsWith('Cannot')).toBe(false);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('9: the review insert returns null: HoldReviewChangedError and the claim rolls back', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    reviewInsert.refuse = true;
    await expect(releaseTransfer(store, db, t.id, REL, undefined, review(t, 'kyc', 'documents_verified'))).rejects.toBeInstanceOf(HoldReviewChangedError);
    expect(await snapshot(t.id)).toEqual({ ...before, status: 'in_review' });
  });

  it('10/21: identity missing, originator missing and an active sender stamp on real money: their refusal, and the transaction wrote nothing (M5)', async () => {
    await delegated();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'seam_ident' });
    await db.execute(sql`UPDATE transfers SET recipient_legal_name_enc = NULL WHERE id = ${a.id}`);
    let before = await snapshot(a.id);
    expect(await releaseHold(db, a, await rail(), undefined, undefined, review(a, 'kyc', 'documents_verified'))).toEqual({ kind: 'identity_missing' });
    expect(await snapshot(a.id)).toEqual(before);

    const b = await heldRowFor(db, 'acme', 'kyc', { id: 'seam_orig' });
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = ${b.phone}`);
    before = await snapshot(b.id);
    expect(await releaseHold(db, b, await rail(), undefined, undefined, review(b, 'kyc', 'documents_verified'))).toEqual({ kind: 'originator_missing' });
    expect(await snapshot(b.id)).toEqual(before);
    await seedOriginatorForTest(db, 'acme', b.phone, { address: true, dob: true });

    const c = await heldRowFor(db, 'acme', 'kyc', { id: 'seam_sender' });
    const rv = review(c, 'kyc', 'documents_verified');
    await db.execute(sql`UPDATE customers SET screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${c.phone}`);
    before = await snapshot(c.id);
    expect(await releaseHold(db, c, await rail(), undefined, undefined, rv)).toEqual({ kind: 'sender_hold' });
    expect(await snapshot(c.id)).toEqual(before);
    expect(before.reviews).toBe(0);
  });

  it('11: mixed LARGE + POSSIBLE_MATCH: the kyc release routes to record; recordHoldStep records it; the sanctions_review release then releases', async () => {
    await delegated();
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const kycRv = review(t, 'kyc', 'documents_verified');
    expect(await releaseHold(db, t, await rail(), undefined, undefined, kycRv)).toEqual({ kind: 'changed', why: 'changed' });
    const outboxBefore = await count('outbox');
    const step = await recordHoldStep(db, { ...kycRv, transferId: t.id });
    expect(step).toEqual({ kind: 'recorded', reviewId: expect.any(String), final: true });
    const hr = await audits(t.id, 'transfer.hold.review');
    expect(hr).toHaveLength(1);
    expect(hr[0].meta).toMatchObject({
      reviewId: (step as { reviewId: string }).reviewId, step: 1, final: true, disposition: 'documents_verified', holdClass: 'kyc', actorScope: 'platform',
    });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    // T23 (P21): the final record queues exactly its hold.disposition event.
    expect((await outboxKeys()).slice(outboxBefore)).toEqual([`hold.disposition:${(step as { reviewId: string }).reviewId}`]);

    expect(await releaseHold(db, t, await rail(), undefined, undefined, review(t, 'sanctions_review', 'false_positive_match'))).toEqual({
      kind: 'released', webhookDriven: true,
    });
    expect((await reviewRows(t.id)).map((r) => r.hold_class)).toEqual(['kyc', 'sanctions_review']);
  });

  it('12: queue owner, four-eyes, partner kyc: co-a records step 1, co-a again is same_actor, co-b releases at step 2', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await recordHoldStep(db, { ...partnerReview(t, 'co-a', false), transferId: t.id })).toEqual({
      kind: 'recorded', reviewId: expect.any(String), final: false,
    });
    const outboxAfterStep1 = await count('outbox');
    expect(await recordHoldStep(db, { ...partnerReview(t, 'co-a', false), transferId: t.id })).toEqual({ kind: 'changed', why: 'same_actor' });
    expect(await count('outbox')).toBe(outboxAfterStep1);
    expect(await releaseHold(db, t, await rail(), undefined, undefined, partnerReview(t, 'co-b', true))).toEqual({ kind: 'released', webhookDriven: true });
    const rows = await reviewRows(t.id);
    expect(rows.map((r) => [r.actor, r.step, r.final, r.actor_scope])).toEqual([['co-a', 1, false, 'partner'], ['co-b', 2, true, 'partner']]);
  });

  it('13: recordHoldStep refuses a route that releases, a list_wait row and a data_missing release; nothing written', async () => {
    await delegated();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'rec_rel' });
    expect(await recordHoldStep(db, { ...review(a, 'kyc', 'documents_verified'), transferId: a.id })).toEqual({ kind: 'changed', why: 'changed' });
    const b = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'rec_list' })).id, [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    expect(await recordHoldStep(db, { ...review(b, 'kyc', 'documents_verified'), transferId: b.id })).toEqual({ kind: 'changed', why: 'waits_list' });
    const c = await setReasons((await heldRowFor(db, 'acme', 'data_missing', { id: 'rec_data' })).id, [LARGE_AMOUNT_REASON, ORIGINATOR_INFO_MISSING_REASON]);
    // The rows above share the one fixture sender, whose data they put on file: take it off again.
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = ${c.phone}`);
    expect(await recordHoldStep(db, { ...review(c, 'kyc', 'documents_verified'), transferId: c.id })).toEqual({ kind: 'changed', why: 'waits_data' });
    for (const id of [a.id, b.id, c.id]) {
      expect(await count('hold_reviews', id)).toBe(0);
      expect(await audits(id, 'transfer.hold.review')).toEqual([]);
    }
  });

  it('15: review with partnerRelease throws before any read; review.pepClear no longer does (T9 wired it); review.ownerId != the row owner: HoldReviewChangedError', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const rv = review(t, 'kyc', 'documents_verified');
    ownerRead.mode = 'throw';
    await expect(releaseTransfer(store, db, 'no_such_row', REL, { partnerId: 'acme' }, rv)).rejects.toThrow(/exclusive/);
    // T9: the placeholder throw is gone; the call reads on (and finds no row).
    await expect(releaseTransfer(store, db, 'no_such_row', REL, undefined, { ...rv, pepClear: { reviewedFlaggedAt: new Date().toISOString() } }))
      .rejects.toThrow('Transfer not found');
    await expect(releaseTransfer(store, db, 'no_such_row', { actor: 'someone-else', reason: REASON }, undefined, rv)).rejects.toThrow(/audit context/);
    ownerRead.mode = 'real';
    const before = await snapshot(t.id);
    await expect(releaseTransfer(store, db, t.id, REL, undefined, { ...rv, ownerId: 'other' })).rejects.toBeInstanceOf(HoldReviewChangedError);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('17: the owner is re-read in the transaction: a platform kyc review on a queue owner is not_yours; a certification revoked after the plan is changed', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    const err = await releaseTransfer(store, db, t.id, REL, undefined, review(t, 'kyc', 'documents_verified')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldReviewChangedError);
    expect((err as HoldReviewChangedError).why).toBe('not_yours');
    expect(await snapshot(t.id)).toEqual(before);

    const planned = partnerReview(t, 'co-a', true);
    await db.execute(sql`UPDATE partners SET live_controls = '{}'::jsonb WHERE id = 'acme'`);
    expect(await releaseHold(db, t, await rail(), undefined, undefined, planned)).toEqual({ kind: 'changed', why: 'changed' });
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('18: expectFinal must match the locked step (R6), both ways', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const planB = partnerReview(t, 'co-b', false); // B planned before A's step 1: step 1, non-final
    expect(await recordHoldStep(db, { ...partnerReview(t, 'co-a', false), transferId: t.id })).toMatchObject({ kind: 'recorded', final: false });
    expect(await recordHoldStep(db, { ...planB, transferId: t.id })).toEqual({ kind: 'changed', why: 'changed' });
    expect(await count('hold_reviews', t.id)).toBe(1);

    const u = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'r6_conv' })).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(await recordHoldStep(db, { ...partnerReview(u, 'co-a', true), transferId: u.id })).toEqual({ kind: 'changed', why: 'changed' });
    expect(await count('hold_reviews', u.id)).toBe(0);
  });

  it('19: a watchlist stamp after the hold (R1): the partner kyc decision is recorded; the platform sender release refuses until the stamp is cleared', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    // O3: a small SQL step for the later stamp (heldRowFor has no option for it).
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    expect(await recordHoldStep(db, { ...partnerReview(t, 'co-a', true), transferId: t.id })).toMatchObject({ kind: 'recorded', final: true });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');

    const sender = review(t, 'sender_watchlist', 'false_positive_match');
    const before = await snapshot(t.id);
    expect(await releaseHold(db, t, await rail(), undefined, undefined, sender)).toEqual({ kind: 'sender_hold' });
    await expect(releaseTransfer(store, db, t.id, REL, undefined, sender)).rejects.toThrow(SENDER_SCREENING_RELEASE_REFUSAL);
    expect(await snapshot(t.id)).toEqual(before);

    await db.execute(sql`UPDATE customers SET screening_cleared_at = screening_flagged_at + interval '1 second' WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    await releaseTransfer(store, db, t.id, REL, undefined, sender);
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.actor_scope])).toEqual([['kyc', 'partner'], ['sender_watchlist', 'platform']]);
  });

  it("20: data on file (R11): another transfer's pay page wrote the originator data; the platform data_received release releases, the reason tag stays", async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'data_missing');
    const rv = review(t, 'data_missing', 'data_received');
    expect(await releaseHold(db, t, await rail(), undefined, undefined, rv)).toEqual({ kind: 'changed', why: 'waits_data' });
    const dob = new Date(Date.now() - 40 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    await writeOriginatorInfo(db, { partnerId: 'acme', phone: t.phone }, { address: '1 Test Street, Testville', dateOfBirth: dob }, { source: 'pay_page', transferId: 'another_tx' });
    await releaseTransfer(store, db, t.id, REL, undefined, rv);
    const paid = await store.getTransfer(t.id);
    expect(paid?.status).toBe('paid');
    expect(paid?.complianceReasons).toContain(ORIGINATOR_INFO_MISSING_REASON);
    expect(await reviewRows(t.id)).toHaveLength(1);
  });
});

// A LARGE hold whose newest screen is 40 h old (release-rescreen.test.ts fixtures).
const SENDER_PHONE = '15551230000';
async function heldStale(id: string, recipientName = 'Anita'): Promise<Transfer> {
  const nowIso = new Date().toISOString();
  await createCustomerStore(db, store).saveCustomer({
    senderPhone: SENDER_PHONE, firstSeenAt: nowIso, kycStatus: 'verified', fullName: 'Alex Sender',
    senderCountry: 'US', partnerId: 'acme', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  });
  await seedOriginatorForTest(db, 'acme', SENDER_PHONE, { address: true, dob: true });
  const t = {
    id, phone: SENDER_PHONE, amountUsd: 1500, feeUsd: 5, totalChargeUsd: 1505, fxRate: 83, amountInr: 124500,
    recipientName, recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234',
    fundingMethod: 'bank_transfer', status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 41 * H).toISOString(), partnerId: 'acme', environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 1500, feeSource: 5, totalChargeSource: 1505, recipientLegalName: 'Anita Legal',
  } as Transfer;
  await store.saveTransfer(t);
  await seedLiveEvidence(db, { id, partnerId: 'acme', recipientName, senderName: 'Alex Sender' }, { screenedAgoMs: 40 * H, at: new Date(Date.now() - 40 * H) });
  expect(await beginHold(db, t, { addReasons: [LARGE_AMOUNT_REASON] })).toEqual({ kind: 'held' });
  return (await store.getTransfer(id))!;
}
const screens = async (id: string) => (await audits(id, 'sanctions.screen')).length;

// Fix pack 7 T9 (P9 step 6, P23): a partner that decides KYC lifts a PEP-only sender hold with
// its release decision: clearPepInTx runs in the seam's transaction after identity / originator
// and right before the platform sender rule; every refusal after it rolls the clear back (M5).
describe('the PEP clear in the release seam (T9)', { retry: 0 }, () => {
  type Cust = { c: string | Date | null };
  async function clearedAt(phone: string): Promise<number | null> {
    const r = (await db.execute(sql`SELECT screening_cleared_at AS c FROM customers WHERE partner_id = 'acme' AND phone = ${phone}`)) as unknown as Rows<Cust>;
    return r.rows[0]?.c == null ? null : new Date(r.rows[0].c).getTime();
  }
  async function clearAudits(phone: string): Promise<AuditRow[]> {
    return audits(auditSubjectId('acme', phone), 'customer.screening_hold.clear');
  }
  async function pepRelease(t: Transfer, o: Partial<HoldReviewInput> = {}): Promise<HoldReviewInput> {
    const f = (await readSenderScreeningFlags(db, 'acme', t.phone))!;
    return review(t, 'sender_pep', 'pep_accepted_with_edd', {
      actor: 'co-a', actorScope: 'partner', expectFinal: true,
      pepClear: { reviewedFlaggedAt: f.screeningFlaggedAt ? f.screeningFlaggedAt.toISOString() : '' }, ...o,
    });
  }
  const CO_A = { actor: 'co-a', reason: REASON };

  it('8: queue + partnerDecidesKyc owner, a PEP-only sender: the partner release clears and releases in ONE transaction (the unlocked pre-read skipped)', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const rv = await pepRelease(t);
    await releaseTransfer(store, db, t.id, CO_A, undefined, rv);
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect(await clearedAt(t.phone)).not.toBeNull();
    const clear = await clearAudits(t.phone);
    expect(clear).toHaveLength(1);
    expect(clear[0].actor).toBe('co-a');
    expect(clear[0].meta).toMatchObject({ pepHit: true, watchlistHit: false, actorScope: 'partner', via: 'hold_review', transferId: t.id });
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.disposition, r.actor_scope])).toEqual([['sender_pep', 'pep_accepted_with_edd', 'partner']]);
    expect(await audits(t.id, 'transfer.release')).toHaveLength(1);
  });

  it('9: a watchlist sender, or a newer match than the reviewed one: changed (KycScreeningChangedError mapped), not released, not cleared', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const stale = await pepRelease(t, {
      pepClear: { reviewedFlaggedAt: new Date(Date.now() - 5 * H).toISOString() },
    });
    let before = await snapshot(t.id);
    expect(await releaseHold(db, t, await rail(), undefined, undefined, stale)).toEqual({ kind: 'changed', why: 'changed' });
    expect(await snapshot(t.id)).toEqual(before);
    expect(await clearedAt(t.phone)).toBeNull();
    expect(await clearAudits(t.phone)).toEqual([]);

    const rv = await pepRelease(t);
    await db.execute(sql`UPDATE customers SET watchlist_hit = true WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    before = await snapshot(t.id);
    expect(await releaseHold(db, t, await rail(), undefined, undefined, rv)).toEqual({ kind: 'changed', why: 'changed' });
    const err = await releaseTransfer(store, db, t.id, CO_A, undefined, rv).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldReviewChangedError);
    expect(await snapshot(t.id)).toEqual(before);
    expect(await clearedAt(t.phone)).toBeNull();
    expect(await clearAudits(t.phone)).toEqual([]);
  });

  it('10: a partner sender_pep release without pepClear is disposition; pepClear on a kyc review throws; a platform sender_pep release without pepClear meets the sender rule', async () => {
    await certifiedQueuePartner(db);
    // A kyc row first (heldRowFor rows share one sender; the sender_pep row below flags it).
    const k = await heldRowFor(db, 'acme', 'kyc', { id: 'pep_on_kyc' });
    const kycWithClear = { ...partnerReview(k, 'co-a', true), pepClear: { reviewedFlaggedAt: '' } };
    await expect(releaseHold(db, k, await rail(), undefined, undefined, kycWithClear)).rejects.toThrow(/pepClear is for a final partner sender_pep release only/);
    expect((await store.getTransfer(k.id))?.status).toBe('in_review');
    expect(await count('hold_reviews', k.id)).toBe(0);
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const before = await snapshot(t.id);
    const noClear = { ...(await pepRelease(t)), pepClear: undefined };
    expect(await releaseHold(db, t, await rail(), undefined, undefined, noClear)).toEqual({ kind: 'changed', why: 'disposition' });
    expect(await recordHoldStep(db, { ...noClear, transferId: t.id })).toEqual({ kind: 'changed', why: 'changed' });
    expect(await snapshot(t.id)).toEqual(before);


    db = await freshDb();
    store = createStore(fakeRedis(), db);
    await delegated();
    const p = await heldRowFor(db, 'acme', 'sender_pep');
    const platform = review(p, 'sender_pep', 'pep_accepted_with_edd');
    expect(await releaseHold(db, p, await rail(), undefined, undefined, platform)).toEqual({ kind: 'sender_hold' });
    expect(await clearedAt(p.phone)).toBeNull();
    expect(await count('hold_reviews', p.id)).toBe(0);
  });

  it('11: recordHoldStep on a mixed row (sender_pep + kyc): the final partner sender_pep release with pepClear is recorded and clears the sender; the row stays in_review', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'sender_pep')).id, [LARGE_AMOUNT_REASON, SENDER_SCREENING_REASON]);
    const rv = await pepRelease(t);
    expect(await recordHoldStep(db, { ...rv, transferId: t.id })).toEqual({ kind: 'recorded', reviewId: expect.any(String), final: true });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await clearedAt(t.phone)).not.toBeNull();
    expect(await clearAudits(t.phone)).toHaveLength(1);
    expect(await audits(t.id, 'transfer.hold.review')).toHaveLength(1);

    // The kyc class then releases the row (the sender is cleared).
    await releaseTransfer(store, db, t.id, CO_A, undefined, partnerReview(t, 'co-a', true));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
  });

  it('12: M5: identity or originator missing on a sender_pep release with pepClear: their refusal, the customer row NOT cleared, no clear audit', async () => {
    await certifiedQueuePartner(db);
    const a = await heldRowFor(db, 'acme', 'sender_pep', { id: 'pep_ident' });
    await db.execute(sql`UPDATE transfers SET recipient_legal_name_enc = NULL WHERE id = ${a.id}`);
    let rv = await pepRelease(a);
    let before = await snapshot(a.id);
    expect(await releaseHold(db, a, await rail(), undefined, undefined, rv)).toEqual({ kind: 'identity_missing' });
    expect(await snapshot(a.id)).toEqual(before);
    expect(await clearedAt(a.phone)).toBeNull();
    expect(await clearAudits(a.phone)).toEqual([]);

    const b = await heldRowFor(db, 'acme', 'sender_pep', { id: 'pep_orig' });
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = ${b.phone}`);
    rv = await pepRelease(b);
    before = await snapshot(b.id);
    expect(await releaseHold(db, b, await rail(), undefined, undefined, rv)).toEqual({ kind: 'originator_missing' });
    expect(await snapshot(b.id)).toEqual(before);
    expect(await clearedAt(b.phone)).toBeNull();
    expect(await clearAudits(b.phone)).toEqual([]);
  });

  it('12b (F1): four-eyes: pepClear on a step the LOCKED route finds non-final -> changed, nothing written; pepClear on a kyc step 1 still throws', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    // A kyc row first (heldRowFor rows share one sender; the sender_pep row below flags it).
    const k = await heldRowFor(db, 'acme', 'kyc', { id: 'pep_on_kyc4' });
    const kycWithClear = { ...partnerReview(k, 'co-a', false), pepClear: { reviewedFlaggedAt: '' } };
    await expect(recordHoldStep(db, { ...kycWithClear, transferId: k.id })).rejects.toThrow(/pepClear is for a final partner sender_pep release only/);
    expect(await count('hold_reviews', k.id)).toBe(0);

    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const before = await snapshot(t.id);
    const step1 = await pepRelease(t, { expectFinal: false });
    expect(await recordHoldStep(db, { ...step1, transferId: t.id })).toEqual({ kind: 'changed', why: 'changed' });
    expect(await snapshot(t.id)).toEqual(before);
    expect(await clearedAt(t.phone)).toBeNull();
    expect(await clearAudits(t.phone)).toEqual([]);

    // Step 1 without pepClear is recorded and clears nothing; step 2 (co-b, final) with pepClear clears and releases.
    expect(await recordHoldStep(db, { ...step1, pepClear: undefined, transferId: t.id })).toMatchObject({ kind: 'recorded', final: false });
    expect(await clearedAt(t.phone)).toBeNull();
    expect(await clearAudits(t.phone)).toEqual([]);
    await releaseTransfer(store, db, t.id, { actor: 'co-b', reason: REASON }, undefined, await pepRelease(t, { actor: 'co-b' }));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect(await clearedAt(t.phone)).not.toBeNull();
    expect(await clearAudits(t.phone)).toHaveLength(1);
  });
});

describe('releaseHoldAfterRescreen with a review (DP2)', { retry: 0 }, () => {
  it('14a: 40 h old screen, list live, clear: released, the review row written with the release', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await delegated();
    const t = await heldStale('rs_clear');
    await releaseTransfer(store, db, t.id, REL, undefined, review(t, 'kyc', 'documents_verified'));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect(await screens(t.id)).toBe(2);
    expect(await reviewRows(t.id)).toEqual([expect.objectContaining({ hold_class: 'kyc', final: true })]);
    expect((await audits(t.id, 'transfer.release'))[0].meta).toMatchObject({ reviewId: expect.any(String), holdClass: 'kyc', actorScope: 'platform' });
  });

  it('14b: list not live: held, no review row, the list-not-live text', async () => {
    primeOfacSource({ checkedAgoMs: 40 * H });
    await delegated();
    const t = await heldStale('rs_list');
    await expect(releaseTransfer(store, db, t.id, REL, undefined, review(t, 'kyc', 'documents_verified'))).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.listNotLive);
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await count('hold_reviews', t.id)).toBe(0);
  });

  it('14c: a match: blocked, no review row', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await delegated();
    const t = await heldStale('rs_match', 'Testa Fixturelli');
    await expect(releaseTransfer(store, db, t.id, REL, undefined, review(t, 'kyc', 'documents_verified'))).rejects.toThrow(PLATFORM_RESCREEN_REFUSALS.blocked);
    expect((await store.getTransfer(t.id))?.complianceStatus).toBe('blocked');
    expect(await count('hold_reviews', t.id)).toBe(0);
  });

  it('14d: a stale rowFp: changed with NO new sanctions.screen row', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await delegated();
    const t = await heldStale('rs_stale');
    const before = await snapshot(t.id);
    await expect(releaseTransfer(store, db, t.id, REL, undefined, review(t, 'kyc', 'documents_verified', { rowFp: 'v1|stale' })))
      .rejects.toBeInstanceOf(HoldReviewChangedError);
    expect(await screens(t.id)).toBe(1);
    expect(await snapshot(t.id)).toEqual(before);
  });
});

describe('releaseHoldAfterRescreen with a pepClear review (T9)', { retry: 0 }, () => {
  async function pepRow(id: string): Promise<{ t: Transfer; flaggedAt: string }> {
    const held = await heldStale(id);
    // The re-screen re-derives LARGE (1 500 USD), so the row keeps it: the partner's kyc step is
    // recorded first, the sender_pep release then closes the row.
    const t = await setReasons(held.id, [LARGE_AMOUNT_REASON, SENDER_SCREENING_REASON]);
    const flagged = new Date(Date.now() - H);
    await db.execute(sql`UPDATE customers SET pep_hit = true, screening_flagged_at = ${flagged} WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    expect(await recordHoldStep(db, { ...partnerReview(t, 'co-b', true), transferId: t.id })).toMatchObject({ kind: 'recorded', final: true });
    return { t, flaggedAt: flagged.toISOString() };
  }
  const cleared = async (phone: string) =>
    ((await db.execute(sql`SELECT screening_cleared_at AS c FROM customers WHERE partner_id = 'acme' AND phone = ${phone}`)) as unknown as Rows<{ c: unknown }>).rows[0].c;
  const pepReview = (t: Transfer, reviewedFlaggedAt: string) =>
    review(t, 'sender_pep', 'pep_accepted_with_edd', { actor: 'co-a', actorScope: 'partner', pepClear: { reviewedFlaggedAt } });

  it('14e: a 40 h old screen, list live, clear: the PEP clear and the release commit together', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await certifiedQueuePartner(db);
    const { t, flaggedAt } = await pepRow('rs_pep');
    await releaseTransfer(store, db, t.id, { actor: 'co-a', reason: REASON }, undefined, pepReview(t, flaggedAt));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect(await screens(t.id)).toBe(2);
    expect(await cleared(t.phone)).not.toBeNull();
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.actor_scope])).toEqual([['kyc', 'partner'], ['sender_pep', 'partner']]);
  });

  it('14f: a newer match than the reviewed one: changed; the clear rolls back (savepoint), the re-screen evidence stays', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await certifiedQueuePartner(db);
    const { t } = await pepRow('rs_pep_stale');
    const err = await releaseTransfer(store, db, t.id, { actor: 'co-a', reason: REASON }, undefined, pepReview(t, new Date(Date.now() - 5 * H).toISOString()))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldReviewChangedError);
    expect((err as HoldReviewChangedError).why).toBe('changed');
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await screens(t.id)).toBe(2);
    expect(await cleared(t.phone)).toBeNull();
    expect(await count('hold_reviews', t.id)).toBe(1); // the kyc step only
  });
});

describe('the automatic sweep is unchanged (D4)', { retry: 0 }, () => {
  it('16: queue owner, LARGE + LIST_UNAVAILABLE, list live: stillHeld 1, reasons [LARGE], no review row', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    expect(await sweepListUnavailableHolds(db, new Date())).toMatchObject({ released: 0, stillHeld: 1 });
    expect((await store.getTransfer(t.id))?.complianceReasons).toEqual([LARGE_AMOUNT_REASON]);
    expect(await count('hold_reviews', t.id)).toBe(0);
  });
});
