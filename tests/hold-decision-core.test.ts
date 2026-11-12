/**
 * Fix pack 7 T10 (P13): the shared decision core. planHoldDecision is the
 * unlocked pre-route (route, step, step-up; a refusal throws
 * HoldReviewChangedError with the route's why, before any write); decideHold
 * hands the decision to exactly one path (recordHoldStep, releaseTransfer or
 * rejectTransfer with the review), builds the audit context from the review
 * itself and pokes after every final outcome (C6). The locked paths stay
 * authoritative.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { certifiedQueuePartner, heldRowFor } from './helpers-hold';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { decideHold, parseHoldReason, planHoldDecision, HoldReviewChangedError, recordHoldStep, type HoldReviewInput } from '@/lib/hold-decision';
import { RECIPIENT_IDENTITY_RELEASE_REFUSAL, SENDER_SCREENING_RELEASE_REFUSAL } from '@/lib/dashboard-ops';
import { classifyHold, rowReasonsFp, type HoldClass, type HoldDisposition } from '@/lib/hold-queue';
import {
  LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, ORIGINATOR_INFO_MISSING_REASON, POSSIBLE_MATCH_REASON,
} from '@/lib/compliance-config';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';

const pokes = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => { pokes.n += 1; } };
});

// Call counters on the three money / record paths (wrapping the real functions).
const paths = vi.hoisted(() => ({ release: 0, reject: 0, record: 0 }));
vi.mock('@/lib/dashboard-ops', async (orig) => {
  const real = await orig<typeof import('@/lib/dashboard-ops')>();
  return {
    ...real,
    releaseTransfer: (...a: Parameters<typeof real.releaseTransfer>) => { paths.release += 1; return real.releaseTransfer(...a); },
    rejectTransfer: (...a: Parameters<typeof real.rejectTransfer>) => { paths.reject += 1; return real.rejectTransfer(...a); },
  };
});
vi.mock('@/lib/settlement', async (orig) => {
  const real = await orig<typeof import('@/lib/settlement')>();
  return {
    ...real,
    recordHoldStep: (...a: Parameters<typeof real.recordHoldStep>) => { paths.record += 1; return real.recordHoldStep(...a); },
  };
});

// A hook that runs once, right after the FIRST listForTransfer (the unlocked plan's read).
const afterList = vi.hoisted(() => ({ once: null as null | (() => Promise<void>) }));
vi.mock('@/db/repos/hold-review-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/hold-review-repo')>();
  return {
    ...real,
    createHoldReviewRepo: (...a: Parameters<typeof real.createHoldReviewRepo>) => {
      const repo = real.createHoldReviewRepo(...a);
      return {
        ...repo,
        listForTransfer: async (...l: Parameters<typeof repo.listForTransfer>) => {
          const rows = await repo.listForTransfer(...l);
          const hook = afterList.once;
          afterList.once = null;
          if (hook) await hook();
          return rows;
        },
      };
    },
  };
});

const REASON = 'Checked the documents on file for this hold.';

let db: Db;
let store: ReturnType<typeof createStore>;

beforeEach(async () => {
  pokes.n = 0;
  paths.release = 0;
  paths.reject = 0;
  paths.record = 0;
  afterList.once = null;
  db = await freshDb();
  store = createStore(fakeRedis(), db);
});
afterEach(() => {
  afterList.once = null;
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
type ReviewRow = { hold_class: string; step: number; final: boolean; disposition: string; actor_scope: string; actor: string; reason: string };
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
const delegated = () => certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });

type Input = HoldReviewInput & { transferId: string };
function input(t: Transfer, holdClass: HoldClass, disposition: HoldDisposition, o: Partial<Input> = {}): Input {
  return {
    transferId: t.id, ownerId: t.partnerId, holdClass, rowFp: rowReasonsFp(t.complianceReasons), disposition, reason: REASON,
    actor: 'plat', actorScope: 'platform', evidence: {}, expectFinal: true, ...o,
  };
}
const partnerInput = (t: Transfer, actor: string, disposition: HoldDisposition = 'documents_verified', o: Partial<Input> = {}) =>
  input(t, 'kyc', disposition, { actor, actorScope: 'partner', ...o });
async function why(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HoldReviewChangedError);
  return (err as HoldReviewChangedError).why;
}
const noMoneyPath = () => expect(paths).toEqual({ release: 0, reject: 0, record: 0 });

describe('planHoldDecision (P13, the unlocked pre-route)', { retry: 0 }, () => {
  it('1: route, step and step-up for a queue partner kyc row, with and without four-eyes', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const plan = await planHoldDecision(db, store, partnerInput(t, 'co-a'));
    expect(plan).toMatchObject({ route: { kind: 'release' }, step: { step: 1, final: true }, stepUp: true, rowFp: rowReasonsFp(t.complianceReasons) });
    expect(plan.classes.map((c) => [c.holdClass, c.decider])).toEqual([['kyc', 'partner']]);

    db = await freshDb();
    store = createStore(fakeRedis(), db);
    await certifiedQueuePartner(db, { fourEyes: true });
    const u = await heldRowFor(db, 'acme', 'kyc');
    expect(await planHoldDecision(db, store, partnerInput(u, 'co-a'))).toMatchObject({
      route: { kind: 'record' }, step: { step: 1, final: false }, stepUp: false,
    });
    expect(await planHoldDecision(db, store, partnerInput(u, 'co-a', 'customer_not_verified'))).toMatchObject({
      route: { kind: 'reject' }, step: { step: 1, final: true }, stepUp: true,
    });
    // Reads only.
    expect(await count('hold_reviews', u.id)).toBe(0);
    expect(await audits(u.id, 'transfer.hold.review')).toEqual([]);
  });

  it("2: refuses with the route's why, writing nothing", async () => {
    await certifiedQueuePartner(db);
    const s = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'plan_sanc' });
    expect(await why(planHoldDecision(db, store, input(s, 'sanctions_review', 'false_positive_match', { actor: 'co-a', actorScope: 'partner' })))).toBe('not_yours');

    const l = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'plan_list' })).id, [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    expect(await why(planHoldDecision(db, store, partnerInput(l, 'co-a')))).toBe('waits_list');

    const d = await setReasons((await heldRowFor(db, 'acme', 'data_missing', { id: 'plan_data' })).id, [LARGE_AMOUNT_REASON, ORIGINATOR_INFO_MISSING_REASON]);
    // The rows above share the one fixture sender, whose data they put on file: take it off again.
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = ${d.phone}`);
    expect(await why(planHoldDecision(db, store, partnerInput(d, 'co-a')))).toBe('waits_data');

    const m = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'plan_mixed' })).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(await why(planHoldDecision(db, store, partnerInput(m, 'co-a', 'customer_not_verified')))).toBe('waits_platform');

    const k = await heldRowFor(db, 'acme', 'kyc', { id: 'plan_kyc' });
    expect(await why(planHoldDecision(db, store, partnerInput(k, 'co-a', 'documents_verified', { rowFp: 'v1|stale' })))).toBe('changed');
    expect(await why(planHoldDecision(db, store, partnerInput(k, 'co-a', 'documents_verified', { ownerId: 'other' })))).toBe('changed');
    expect(await why(planHoldDecision(db, store, partnerInput(k, 'co-a', 'documents_verified', { transferId: 'no_such_row' })))).toBe('changed');
    await db.execute(sql`UPDATE transfers SET status = 'paid' WHERE id = ${k.id}`);
    expect(await why(planHoldDecision(db, store, partnerInput(k, 'co-a')))).toBe('changed');

    for (const id of [s.id, l.id, d.id, m.id, k.id]) expect(await count('hold_reviews', id)).toBe(0);
  });
});

describe('decideHold (P13, the shared core)', { retry: 0 }, () => {
  it('3: partner kyc release, fourEyes false: released, paid, one review row, the instruct row', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const keysBefore = await outboxKeys();
    expect(await decideHold(db, store, partnerInput(t, 'co-a'))).toEqual({ outcome: 'released' });
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.step, r.final, r.actor_scope])).toEqual([['kyc', 1, true, 'partner']]);
    expect((await outboxKeys()).slice(keysBefore.length)).toContain(`instruct:${t.id}`);
    // T23 (P21): the final review's hold.disposition event, before the rail effect.
    const relAudit = await audits(t.id, 'transfer.release');
    expect((await outboxKeys()).slice(keysBefore.length)).toEqual([`hold.disposition:${relAudit[0].meta.reviewId as string}`, `instruct:${t.id}`]);
    expect(paths).toEqual({ release: 1, reject: 0, record: 0 });
  });

  it('4: four-eyes: co-a awaiting_second; co-a again same_actor (planned, nothing written); co-b released', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decideHold(db, store, partnerInput(t, 'co-a', 'documents_verified', { expectFinal: false }))).toEqual({ outcome: 'awaiting_second' });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    const before = await snapshot(t.id);
    const recordsBefore = paths.record;
    expect(await why(decideHold(db, store, partnerInput(t, 'co-a', 'documents_verified', { expectFinal: false })))).toBe('same_actor');
    expect(paths.record).toBe(recordsBefore);
    expect(await snapshot(t.id)).toEqual(before);
    expect(await decideHold(db, store, partnerInput(t, 'co-b'))).toEqual({ outcome: 'released' });
    expect((await reviewRows(t.id)).map((r) => [r.actor, r.step, r.final])).toEqual([['co-a', 1, false], ['co-b', 2, true]]);
  });

  it('4b: an expectFinal that is not the planned step refuses changed before any path (R6)', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    expect(await why(decideHold(db, store, partnerInput(t, 'co-a', 'documents_verified', { expectFinal: true })))).toBe('changed');
    noMoneyPath();
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('5: mixed row (kyc partner + sanctions_review platform): partner kyc recorded (row stays in_review); platform false_positive_match released', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(await decideHold(db, store, partnerInput(t, 'co-a'))).toEqual({ outcome: 'recorded' });
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    expect(await decideHold(db, store, input(t, 'sanctions_review', 'false_positive_match'))).toEqual({ outcome: 'released' });
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.actor_scope])).toEqual([['kyc', 'partner'], ['sanctions_review', 'platform']]);
  });

  it('6: platform kyc reject on a certified delegated owner: rejected, cancelled, one review row', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decideHold(db, store, input(t, 'kyc', 'customer_not_verified'))).toEqual({ outcome: 'rejected' });
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect(await reviewRows(t.id)).toHaveLength(1);
    expect(paths).toEqual({ release: 0, reject: 1, record: 0 });
  });

  it('7: the locked re-check wins: a reason added after the plan read refuses changed, nothing written', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    afterList.once = async () => {
      await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify([LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON])}::jsonb WHERE id = ${t.id}`);
    };
    expect(await why(decideHold(db, store, partnerInput(t, 'co-a')))).toBe('changed');
    expect(paths.release).toBe(1); // the plan said release; the locked path refused
    expect(await snapshot(t.id)).toEqual(before);
    expect(pokes.n).toBe(0);
  });

  it('8: partner scope on a certified owner that is not holdQueueApplies: not_yours before any money path', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    expect(await why(decideHold(db, store, partnerInput(t, 'co-a')))).toBe('not_yours');
    noMoneyPath();
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('8b: the review row and the transfer.release / transfer.reject audit row carry the same actor and reason', async () => {
    await delegated();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'same_rel' });
    await decideHold(db, store, input(a, 'kyc', 'documents_verified', { actor: 'plat-x', reason: 'The documents on file match the customer.' }));
    const ra = (await reviewRows(a.id))[0];
    const aa = (await audits(a.id, 'transfer.release'))[0];
    expect([ra.actor, ra.reason]).toEqual(['plat-x', 'The documents on file match the customer.']);
    expect([aa.actor, aa.meta.reason]).toEqual([ra.actor, ra.reason]);

    const b = await heldRowFor(db, 'acme', 'kyc', { id: 'same_rej' });
    await decideHold(db, store, input(b, 'kyc', 'activity_unexplained', { actor: 'plat-y', reason: 'The customer did not explain the activity.' }));
    const rb = (await reviewRows(b.id))[0];
    const ab = (await audits(b.id, 'transfer.reject'))[0];
    expect([rb.actor, rb.reason]).toEqual(['plat-y', 'The customer did not explain the activity.']);
    expect([ab.actor, ab.meta.reason]).toEqual([rb.actor, rb.reason]);
  });

  it('8c: a reject of an UNCHARGED row of a certified owner pokes exactly once (C6); a non-final record does not poke', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(t.fundingRef ?? null).toBeNull();
    await decideHold(db, store, input(t, 'kyc', 'customer_not_verified'));
    expect(pokes.n).toBe(1);

    db = await freshDb();
    store = createStore(fakeRedis(), db);
    pokes.n = 0;
    await certifiedQueuePartner(db, { fourEyes: true });
    const u = await heldRowFor(db, 'acme', 'kyc');
    expect(await decideHold(db, store, partnerInput(u, 'co-a', 'documents_verified', { expectFinal: false }))).toEqual({ outcome: 'awaiting_second' });
    expect(pokes.n).toBe(0);
  });

  it('8d: a final record (mixed row) pokes once', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    expect(await decideHold(db, store, partnerInput(t, 'co-a'))).toEqual({ outcome: 'recorded' });
    expect(pokes.n).toBe(1);
  });

  it('9: refusal Errors pass through unchanged: a nameless http row; a stamped sender', async () => {
    await delegated();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'core_ident' });
    await db.execute(sql`UPDATE transfers SET recipient_legal_name_enc = NULL WHERE id = ${a.id}`);
    let before = await snapshot(a.id);
    await expect(decideHold(db, store, input(a, 'kyc', 'documents_verified'))).rejects.toThrow(RECIPIENT_IDENTITY_RELEASE_REFUSAL);
    expect(await snapshot(a.id)).toEqual(before);

    const b = await heldRowFor(db, 'acme', 'sender_watchlist', { id: 'core_sender' });
    before = await snapshot(b.id);
    await expect(decideHold(db, store, input(b, 'sender_watchlist', 'false_positive_match'))).rejects.toThrow(SENDER_SCREENING_RELEASE_REFUSAL);
    expect(await snapshot(b.id)).toEqual(before);
    expect(pokes.n).toBe(0);
  });

  it('10: sender_pep partner release with pepClear (a partner that decides KYC): released, the clear audited', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    const f = (await readSenderScreeningFlags(db, 'acme', t.phone))!;
    const i = input(t, 'sender_pep', 'pep_accepted_with_edd', {
      actor: 'co-a', actorScope: 'partner', pepClear: { reviewedFlaggedAt: f.screeningFlaggedAt!.toISOString() },
    });
    const plan = await planHoldDecision(db, store, i);
    expect(plan).toMatchObject({ route: { kind: 'release' }, step: { final: true }, stepUp: true });
    expect(await decideHold(db, store, i)).toEqual({ outcome: 'released' });
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    const { auditSubjectId } = await import('@/lib/customer-ref');
    const clear = await audits(auditSubjectId('acme', t.phone), 'customer.screening_hold.clear');
    expect(clear).toHaveLength(1);
    expect(clear[0].meta).toMatchObject({ via: 'hold_review', transferId: t.id, actorScope: 'partner' });
  });

  it('10b: a partner sender_pep release without pepClear is refused disposition by the plan', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'sender_pep');
    expect(await why(planHoldDecision(db, store, input(t, 'sender_pep', 'pep_accepted_with_edd', { actor: 'co-a', actorScope: 'partner' })))).toBe('disposition');
    noMoneyPath();
  });

  it('11: the re-exports are the same objects', async () => {
    expect(parseHoldReason('Checked the documents on file.')).toEqual({ ok: true, reason: 'Checked the documents on file.' });
    expect(HoldReviewChangedError).toBe((await import('@/lib/hold-review-tx')).HoldReviewChangedError);
    expect(recordHoldStep).toBe((await import('@/lib/settlement')).recordHoldStep);
    const typed: HoldReviewInput | null = null;
    expect(typed).toBeNull();
    // classifyHold is unchanged by the core (a sanity pin on the classes the plan returns).
    expect(classifyHold([LARGE_AMOUNT_REASON], undefined, { queue: true, partnerDecidesKyc: true }).map((c) => c.holdClass)).toEqual(['kyc']);
  });
});
