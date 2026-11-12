/**
 * Fix pack 7 T23 (P21 hold.disposition, P9 step 10): every transaction that
 * inserts a FINAL hold_reviews row (partner or platform scope; a release, a
 * reject or a final record of one class while another stays open) queues ONE
 * partner.event of type hold.disposition, dedupe `hold.disposition:<reviewId>`,
 * payload exactly { type, transferId, reviewId, eventId }, when the owner is
 * live-certified and the row is not a sandbox ('test') row. A non-final step
 * queues nothing; a failed enqueue rolls the decision back; a lost claim or a
 * refused route writes neither the review nor the event.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedOriginatorForTest } from './helpers-live';
import { certifiedQueuePartner, heldRowFor } from './helpers-hold';
import { primeOfacSource, restoreOfacSource, seedLiveEvidence } from './helpers-sanctions';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { beginHold, recordHoldStep, releaseHold } from '@/lib/settlement';
import { PLATFORM_RESCREEN_REFUSALS, rejectTransfer, releaseTransfer } from '@/lib/dashboard-ops';
import { decideHold, HoldReviewChangedError, type HoldReviewInput } from '@/lib/hold-decision';
import { enqueueHoldDispositionIfEligible } from '@/lib/partner-events';
import { rowReasonsFp, type HoldClass, type HoldDisposition } from '@/lib/hold-queue';
import { LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON } from '@/lib/compliance-config';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';

const pokes = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => { pokes.n += 1; } };
});

// A switch that makes the outbox enqueue of a partner.event row throw (inside the caller's tx).
const eventEnqueue = vi.hoisted(() => ({ fail: false }));
vi.mock('@/db/repos/outbox-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/outbox-repo')>();
  return {
    ...real,
    createOutboxRepo: (...a: Parameters<typeof real.createOutboxRepo>) => {
      const repo = real.createOutboxRepo(...a);
      return {
        ...repo,
        enqueue: async (...e: Parameters<typeof repo.enqueue>) => {
          if (eventEnqueue.fail && e[0] === 'partner.event') throw new Error('outbox enqueue failed');
          return repo.enqueue(...e);
        },
      };
    },
  };
});

const H = 3_600_000;
const REASON = 'Checked the documents on file for this hold.';
const REL = { actor: 'plat', reason: REASON };

let db: Db;
let store: ReturnType<typeof createStore>;
const originalList = process.env.SANCTIONS_LIST;

beforeEach(async () => {
  pokes.n = 0;
  eventEnqueue.fail = false;
  db = await freshDb();
  store = createStore(fakeRedis(), db);
});
afterEach(() => {
  eventEnqueue.fail = false;
  restoreOfacSource(originalList);
});

type Rows<T> = { rows: T[] };
type EventRow = { payload: Record<string, unknown>; dedupe_key: string | null };
async function events(): Promise<EventRow[]> {
  const r = (await db.execute(sql`SELECT payload, dedupe_key FROM outbox WHERE kind = 'partner.event' ORDER BY id`)) as unknown as Rows<EventRow>;
  return r.rows.map((x) => ({ ...x, payload: typeof x.payload === 'string' ? (JSON.parse(x.payload) as Record<string, unknown>) : x.payload }));
}
const dispositions = async () => (await events()).filter((e) => e.payload.type === 'hold.disposition');
async function reviewIds(id: string): Promise<Array<{ id: string; final: boolean }>> {
  const r = (await db.execute(sql`SELECT id, final FROM hold_reviews WHERE transfer_id = ${id} ORDER BY created_at, step`)) as unknown as Rows<{ id: string; final: boolean }>;
  return r.rows;
}
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
async function setReasons(id: string, reasons: string[]): Promise<Transfer> {
  await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify(reasons)}::jsonb WHERE id = ${id}`);
  return (await store.getTransfer(id))!;
}
const rail = () => createIntegrationsRepo(db).getIntegrations('acme');
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
const reviewOf = (i: Input): HoldReviewInput => {
  const { transferId, ...rv } = i;
  void transferId;
  return rv;
};
function expectEvent(e: EventRow | undefined, transferId: string, reviewId: string): void {
  expect(e).toBeDefined();
  expect(e!.dedupe_key).toBe(`hold.disposition:${reviewId}`);
  expect(Object.keys(e!.payload).sort()).toEqual(['eventId', 'reviewId', 'transferId', 'type']);
  expect(e!.payload).toMatchObject({ type: 'hold.disposition', transferId, reviewId, eventId: expect.any(String) });
}

// A LARGE hold whose newest screen is 40 h old (tests/hold-release-seam.test.ts heldStale).
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

describe('enqueueHoldDispositionIfEligible (P21)', { retry: 0 }, () => {
  it('queues only for a final row of a live-certified owner on a non-sandbox row', async () => {
    await certifiedQueuePartner(db);
    await seedPartner(db, 'plain');
    const t = await heldRowFor(db, 'acme', 'kyc');
    const owner = await createPartnerRepo(db).getPartner('acme');
    const plain = await createPartnerRepo(db).getPartner('plain');
    const rid = '00000000-0000-4000-8000-000000000001';
    expect(await enqueueHoldDispositionIfEligible(db, t, owner, rid, false)).toBe(false);
    expect(await enqueueHoldDispositionIfEligible(db, { ...t, environment: 'test' }, owner, rid, true)).toBe(false);
    expect(await enqueueHoldDispositionIfEligible(db, t, null, rid, true)).toBe(false);
    expect(await enqueueHoldDispositionIfEligible(db, t, plain, rid, true)).toBe(false);
    expect(await events()).toEqual([]);
    expect(await enqueueHoldDispositionIfEligible(db, t, owner, rid, true)).toBe(true);
    // The dedupe key is per review: a replay queues nothing.
    expect(await enqueueHoldDispositionIfEligible(db, t, owner, rid, true)).toBe(false);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expectEvent(ev[0], t.id, rid);
  });
});

describe('hold.disposition in the decision transactions (P21, P9 step 10)', { retry: 0 }, () => {
  it("1: partner kyc release, fourEyes false (decideHold): released; ONE event keyed on the new review id; payload keys exactly ['eventId','reviewId','transferId','type']", async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decideHold(db, store, partnerInput(t, 'co-a'))).toEqual({ outcome: 'released' });
    const rows = await reviewIds(t.id);
    expect(rows).toHaveLength(1);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expectEvent(ev[0], t.id, rows[0].id);
  });

  it('2: fourEyes true: step 1 by co-a -> awaiting_second, NO event and no poke; step 2 by co-b -> released, ONE event for the step-2 review id', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decideHold(db, store, partnerInput(t, 'co-a', 'documents_verified', { expectFinal: false }))).toEqual({ outcome: 'awaiting_second' });
    expect(await events()).toEqual([]);
    expect(pokes.n).toBe(0);
    expect(await decideHold(db, store, partnerInput(t, 'co-b'))).toEqual({ outcome: 'released' });
    const rows = await reviewIds(t.id);
    expect(rows.map((r) => r.final)).toEqual([false, true]);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expectEvent(ev[0], t.id, rows[1].id);
  });

  it('3: partner reject at step 1 (final, four-eyes on) -> rejected, ONE event', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await decideHold(db, store, partnerInput(t, 'co-a', 'customer_not_verified'))).toEqual({ outcome: 'rejected' });
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    const rows = await reviewIds(t.id);
    expect(rows).toHaveLength(1);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expectEvent(ev[0], t.id, rows[0].id);
    expect(pokes.n).toBe(1);
  });

  it('4: mixed row (kyc partner + sanctions_review platform): the final kyc record queues ONE event and pokes; the platform release queues a SECOND event', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const before = (await events()).length;
    expect(await decideHold(db, store, partnerInput(t, 'co-a'))).toEqual({ outcome: 'recorded' });
    expect(pokes.n).toBe(1);
    expect((await store.getTransfer(t.id))?.status).toBe('in_review');
    let rows = await reviewIds(t.id);
    let ev = (await events()).slice(before);
    expect(ev).toHaveLength(1);
    expectEvent(ev[0], t.id, rows[0].id);

    expect(await decideHold(db, store, input(t, 'sanctions_review', 'false_positive_match'))).toEqual({ outcome: 'released' });
    rows = await reviewIds(t.id);
    ev = (await events()).slice(before);
    expect(ev).toHaveLength(2);
    expectEvent(ev[1], t.id, rows[1].id);
    expect(rows[1].id).not.toBe(rows[0].id);
  });

  it('5: a platform decision on a certified smartremit_delegated owner (releaseHold with a platform review): ONE event', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    expect(await releaseHold(db, t, await rail(), undefined, undefined, reviewOf(input(t, 'kyc', 'documents_verified')))).toEqual({
      kind: 'released', webhookDriven: true,
    });
    const rows = await reviewIds(t.id);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expectEvent(ev[0], t.id, rows[0].id);
  });

  it('6: releaseHoldAfterRescreen clear branch with a review (40 h old screen, list live): released, ONE event', async () => {
    primeOfacSource({ checkedAgoMs: H });
    await delegated();
    const t = await heldStale('rs_clear');
    await releaseTransfer(store, db, t.id, REL, undefined, reviewOf(input(t, 'kyc', 'documents_verified')));
    expect((await store.getTransfer(t.id))?.status).toBe('paid');
    const rows = await reviewIds(t.id);
    expect(rows).toHaveLength(1);
    const ev = await dispositions();
    expect(ev).toHaveLength(1);
    expectEvent(ev[0], t.id, rows[0].id);
  });

  it('6b: releaseHoldAfterRescreen held (list not live) and blocked (a match) branches: no review row and no hold.disposition event', async () => {
    primeOfacSource({ checkedAgoMs: 40 * H });
    await delegated();
    const a = await heldStale('rs_list');
    await expect(releaseTransfer(store, db, a.id, REL, undefined, reviewOf(input(a, 'kyc', 'documents_verified')))).rejects.toThrow(
      PLATFORM_RESCREEN_REFUSALS.listNotLive,
    );
    expect(await count('hold_reviews', a.id)).toBe(0);
    expect(await dispositions()).toEqual([]);

    primeOfacSource({ checkedAgoMs: H });
    const b = await heldStale('rs_match', 'Testa Fixturelli');
    await expect(releaseTransfer(store, db, b.id, REL, undefined, reviewOf(input(b, 'kyc', 'documents_verified')))).rejects.toThrow(
      PLATFORM_RESCREEN_REFUSALS.blocked,
    );
    expect(await count('hold_reviews', b.id)).toBe(0);
    expect(await dispositions()).toEqual([]);
  });

  it('7: a lost claim (status moved by SQL before the call): no review row, no event (release, reject, record)', async () => {
    await delegated();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'lost_rel' });
    const rvA = reviewOf(input(a, 'kyc', 'documents_verified'));
    await db.execute(sql`UPDATE transfers SET status = 'paid' WHERE id = ${a.id}`);
    expect(await releaseHold(db, a, await rail(), undefined, undefined, rvA)).toEqual({ kind: 'already' });

    const b = await heldRowFor(db, 'acme', 'kyc', { id: 'lost_rej' });
    const rvB = reviewOf(input(b, 'kyc', 'customer_not_verified'));
    await db.execute(sql`UPDATE transfers SET status = 'cancelled' WHERE id = ${b.id}`);
    await expect(rejectTransfer(store, db, b.id, REL, undefined, rvB)).rejects.toThrow(/not in_review/);

    const c = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'lost_rec' })).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const rvC = input(c, 'kyc', 'documents_verified');
    await db.execute(sql`UPDATE transfers SET status = 'paid' WHERE id = ${c.id}`);
    expect(await recordHoldStep(db, rvC)).toEqual({ kind: 'already' });

    for (const id of [a.id, b.id, c.id]) expect(await count('hold_reviews', id)).toBe(0);
    expect(await events()).toEqual([]);
  });

  it('8: the event enqueue throws inside the transaction: the decision rolls back (in_review, no review, no audit, no outbox row)', async () => {
    await delegated();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'fail_rel', fundingProvider: 'mock', fundingRef: 'mock_pi_fail_rel' });
    const b = await heldRowFor(db, 'acme', 'kyc', { id: 'fail_rej', fundingProvider: 'mock', fundingRef: 'mock_pi_fail_rej' });
    const c = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'fail_rec' })).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const before = { a: await snapshot(a.id), b: await snapshot(b.id), c: await snapshot(c.id) };
    eventEnqueue.fail = true;
    await expect(releaseTransfer(store, db, a.id, REL, undefined, reviewOf(input(a, 'kyc', 'documents_verified')))).rejects.toThrow('outbox enqueue failed');
    await expect(rejectTransfer(store, db, b.id, REL, undefined, reviewOf(input(b, 'kyc', 'customer_not_verified')))).rejects.toThrow('outbox enqueue failed');
    await expect(recordHoldStep(db, input(c, 'kyc', 'documents_verified'))).rejects.toThrow('outbox enqueue failed');
    expect(await snapshot(a.id)).toEqual({ ...before.a, status: 'in_review' });
    expect(await snapshot(b.id)).toEqual({ ...before.b, status: 'in_review' });
    expect(await snapshot(c.id)).toEqual({ ...before.c, status: 'in_review' });
    for (const id of [a.id, b.id, c.id]) {
      expect(await count('hold_reviews', id)).toBe(0);
      expect(await count('audit_events', id)).toBe(before[id === a.id ? 'a' : id === b.id ? 'b' : 'c'].audit);
    }
    expect(await events()).toEqual([]);
  });

  it("9: a sandbox ('test') held row decided with a review: no event", async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${t.id}`);
    const sandbox = (await store.getTransfer(t.id))!;
    const res = await releaseHold(db, sandbox, await rail(), undefined, undefined, reviewOf(input(sandbox, 'kyc', 'documents_verified')));
    expect(res).toMatchObject({ kind: 'released' });
    expect(await count('hold_reviews', t.id)).toBe(1);
    expect(await events()).toEqual([]);
  });

  it('10: the owner lost certification between the caller\'s read and the transaction: changed, no review row, never an event', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const rel = partnerInput(t, 'co-a');
    const k = await heldRowFor(db, 'acme', 'kyc', { id: 'decert_kyc' });
    const relK = partnerInput(k, 'co-a');
    const rejK = partnerInput(k, 'co-a', 'customer_not_verified');
    await db.execute(sql`UPDATE partners SET live_controls = '{}'::jsonb WHERE id = 'acme'`);
    expect(await recordHoldStep(db, rel)).toEqual({ kind: 'changed', why: 'changed' });
    expect(await releaseHold(db, k, await rail(), undefined, undefined, reviewOf(relK))).toEqual({ kind: 'changed', why: 'changed' });
    const err = await rejectTransfer(store, db, k.id, { actor: 'co-a', reason: REASON }, undefined, reviewOf(rejK)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldReviewChangedError);
    for (const id of [t.id, k.id]) expect(await count('hold_reviews', id)).toBe(0);
    expect(await events()).toEqual([]);
  });
});
