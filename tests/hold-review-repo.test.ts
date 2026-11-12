import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer } from './helpers-partner-app';
import { createHoldReviewRepo, HOLD_QUEUE_MAX_IDS, type HoldReviewWrite } from '@/db/repos/hold-review-repo';
import type { Db } from '@/db/client';

// Fix pack 7 T4 (P6): the append-only, tenant-scoped repo over hold_reviews.
// insert is ON CONFLICT DO NOTHING over BOTH unique indexes (null = refused);
// every read is pinned to the OWNER partner id; there is no update or delete.

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  await seedPartnerTransfer(db, { id: 't1', partnerId: 'pa' });
  await seedPartnerTransfer(db, { id: 't2', partnerId: 'pa' });
});

const w = (o: Partial<HoldReviewWrite> = {}): HoldReviewWrite => ({
  transferId: 't1',
  partnerId: 'pa',
  holdClass: 'kyc',
  reasonsFp: 'v1|kyc|Large transfer amount.',
  step: 1,
  final: true,
  disposition: 'documents_verified',
  reason: 'Documents checked and fine',
  evidence: {},
  actor: 'co-a',
  actorScope: 'partner',
  ...o,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('hold-review-repo', () => {
  it('insert returns a uuid id and every column round-trips', async () => {
    const repo = createHoldReviewRepo(db);
    const write = w({ evidence: { listSource: 'ofac-sdn', listVersion: 'v9', maxScore: 0.91, matchedEntryIds: ['e1'], amlKinds: ['aml_rule'] } });
    const r = await repo.insert(write);
    expect(r).not.toBeNull();
    expect(r!.id).toMatch(UUID);
    const rows = await repo.listForTransfer('pa', 't1');
    expect(rows).toHaveLength(1);
    const { id, createdAt, ...rest } = rows[0];
    expect(id).toBe(r!.id);
    expect(rest).toEqual(write);
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
    expect(typeof rows[0].evidence).toBe('object');
  });

  it('insert returns null when (transfer, class, fp, step) repeats', async () => {
    const repo = createHoldReviewRepo(db);
    expect(await repo.insert(w())).not.toBeNull();
    expect(await repo.insert(w({ actor: 'co-b' }))).toBeNull();
    expect(await repo.listForTransfer('pa', 't1')).toHaveLength(1);
  });

  it('insert returns null when (transfer, class, fp, actor) repeats', async () => {
    const repo = createHoldReviewRepo(db);
    expect(await repo.insert(w({ final: false }))).not.toBeNull();
    expect(await repo.insert(w({ step: 2 }))).toBeNull();
    expect(await repo.listForTransfer('pa', 't1')).toHaveLength(1);
    // A new cycle (another fingerprint): the same actor is accepted.
    expect(await repo.insert(w({ reasonsFp: 'v1|kyc|Large transfer amount.|High transfer velocity.' }))).not.toBeNull();
    expect(await repo.listForTransfer('pa', 't1')).toHaveLength(2);
  });

  it('a FK error propagates (an unknown transfer throws)', async () => {
    await expect(createHoldReviewRepo(db).insert(w({ transferId: 'nope' }))).rejects.toThrow();
  });

  it('listForTransfer is tenant-pinned', async () => {
    const repo = createHoldReviewRepo(db);
    await repo.insert(w());
    expect(await repo.listForTransfer('pb', 't1')).toEqual([]);
    // A row written under 'pb' on t1 is not returned for 'pa'.
    await repo.insert(w({ partnerId: 'pb', reasonsFp: 'other', actor: 'co-x' }));
    const pa = await repo.listForTransfer('pa', 't1');
    expect(pa).toHaveLength(1);
    expect(pa.every((r) => r.partnerId === 'pa')).toBe(true);
    expect((await repo.listForTransfer('pb', 't1')).map((r) => r.actor)).toEqual(['co-x']);
  });

  it('listForTransfer orders by created_at then step', async () => {
    const repo = createHoldReviewRepo(db);
    // One transaction: now() is the transaction start, so both rows share
    // created_at and step decides (step 2 inserted first on purpose).
    await db.transaction(async (tx) => {
      const r = createHoldReviewRepo(tx);
      await r.insert(w({ step: 2, actor: 'co-b' }));
      await r.insert(w({ step: 1, actor: 'co-a', final: false }));
    });
    // A later transaction: a later created_at sorts last whatever its step.
    await repo.insert(w({ reasonsFp: 'later', actor: 'co-c' }));
    const rows = await repo.listForTransfer('pa', 't1');
    expect(rows.map((r) => [r.reasonsFp, r.step])).toEqual([
      ['v1|kyc|Large transfer amount.', 1],
      ['v1|kyc|Large transfer amount.', 2],
      ['later', 1],
    ]);
  });

  it('getById is tenant-pinned', async () => {
    const repo = createHoldReviewRepo(db);
    const r = await repo.insert(w());
    expect((await repo.getById('pa', r!.id))?.actor).toBe('co-a');
    expect(await repo.getById('pb', r!.id)).toBeNull();
    expect(await repo.getById('pa', '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('listForQueue: the given ids only, own tenant only; [] reads nothing; more than 50 ids throws', async () => {
    const repo = createHoldReviewRepo(db);
    await seedPartnerTransfer(db, { id: 't3', partnerId: 'pa' });
    await repo.insert(w());
    await repo.insert(w({ transferId: 't2' }));
    await repo.insert(w({ transferId: 't3' }));
    await repo.insert(w({ transferId: 't2', partnerId: 'pb', reasonsFp: 'pb-row', actor: 'co-x' }));
    const rows = await repo.listForQueue('pa', ['t1', 't2']);
    expect(rows.map((r) => r.transferId).sort()).toEqual(['t1', 't2']);
    expect(rows.every((r) => r.partnerId === 'pa')).toBe(true);
    expect(await repo.listForQueue('pa', [])).toEqual([]);
    expect(HOLD_QUEUE_MAX_IDS).toBe(50);
    const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
    await expect(repo.listForQueue('pa', ids)).rejects.toBeInstanceOf(RangeError);
    await expect(repo.listForQueue('pa', ids.slice(0, 50))).resolves.toHaveLength(3);
  });

  it('the repo has no update or delete', () => {
    expect(Object.keys(createHoldReviewRepo(db)).sort()).toEqual(['getById', 'insert', 'listForQueue', 'listForTransfer']);
  });

  it('a raw UPDATE is refused by the trigger (the DB proof is tests/pack7-migration.test.ts)', async () => {
    await createHoldReviewRepo(db).insert(w());
    await expect(db.execute(sql`UPDATE hold_reviews SET reason = 'changed'`)).rejects.toThrow();
  });
});
