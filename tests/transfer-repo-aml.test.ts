import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import type { Db } from '@/db/client';

// Program-Fix 43: the AML sweep's ledger reads. Every sender read is keyed
// (partner_id, phone), strictly before the transfer under test in
// (created_at, id) order, and excludes blocked + cancelled rows (fix 16's
// totals do the same).

const DAY = 86_400_000;
const PHONE = '15550002222';
let db: Db;
let now: number;

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p2');
  now = Date.now();
});

const ago = (ms: number) => new Date(now - ms);

describe('senderAmlStats', () => {
  it('counts band sends in 7 days, sums sub-T in 30 days, and prior count, before the anchor only', async () => {
    const repo = createTransferRepo(db);
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: ago(2 * DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 850, createdAt: ago(6 * DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: ago(9 * DAY) }); // outside 7d of the anchor, inside 30d
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 200, createdAt: ago(10 * DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 5000, createdAt: ago(3 * DAY) }); // >= T: not sub-T
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 700, createdAt: ago(40 * DAY) }); // outside 30d
    const anchorId = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: ago(DAY) });
    // after the anchor: never counted
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: ago(1000) });

    const s = await repo.senderAmlStats('default', PHONE, { at: ago(DAY), id: anchorId }, 1000, 0.8);
    expect(s).toEqual({ bandCount7d: 2, subTSumCents30d: (900 + 850 + 900 + 200) * 100, subTCount30d: 4, priorCount: 6 });
  });

  it('excludes blocked and cancelled rows and is tenant-keyed', async () => {
    const repo = createTransferRepo(db);
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: ago(2 * DAY), status: 'blocked' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: ago(2 * DAY), status: 'cancelled' });
    await seedLedgerSpend(db, { partnerId: 'p2', phone: PHONE, amountUsd: 900, createdAt: ago(2 * DAY) });
    const anchorId = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: ago(DAY) });
    const s = await repo.senderAmlStats('default', PHONE, { at: ago(DAY), id: anchorId }, 1000, 0.8);
    expect(s).toEqual({ bandCount7d: 0, subTSumCents30d: 0, subTCount30d: 0, priorCount: 0 });
  });

  it('same-timestamp rows are ordered by id (strict tuple order)', async () => {
    const repo = createTransferRepo(db);
    const at = ago(DAY);
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: at, id: 'tr_a' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 900, createdAt: at, id: 'tr_b' });
    expect((await repo.senderAmlStats('default', PHONE, { at, id: 'tr_a' }, 1000, 0.8)).priorCount).toBe(0);
    expect((await repo.senderAmlStats('default', PHONE, { at, id: 'tr_b' }, 1000, 0.8)).priorCount).toBe(1);
  });
});

describe('listCreatedSince', () => {
  it('keyset ascending after the cursor, strictly before the lag cutoff, bounded', async () => {
    const repo = createTransferRepo(db);
    const a = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1, createdAt: ago(10 * 60_000), id: 'tr_1' });
    await seedLedgerSpend(db, { partnerId: 'p2', phone: PHONE, amountUsd: 1, createdAt: ago(9 * 60_000), id: 'tr_2' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1, createdAt: ago(9 * 60_000), id: 'tr_3' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1, createdAt: ago(60_000), id: 'tr_late' });
    const cutoff = ago(2 * 60_000);

    const all = await repo.listCreatedSince({ at: ago(DAY), id: '' }, cutoff, 10);
    expect(all.map((t) => t.id)).toEqual([a, 'tr_2', 'tr_3']);

    const after = await repo.listCreatedSince({ at: ago(9 * 60_000), id: 'tr_2' }, cutoff, 10);
    expect(after.map((t) => t.id)).toEqual(['tr_3']);

    expect((await repo.listCreatedSince({ at: ago(DAY), id: '' }, cutoff, 2)).map((t) => t.id)).toEqual([a, 'tr_2']);
  });

  it('returns masked rows (no plaintext destination)', async () => {
    const repo = createTransferRepo(db);
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1, createdAt: ago(10 * 60_000) });
    const [t] = await repo.listCreatedSince({ at: ago(DAY), id: '' }, ago(60_000), 10);
    expect(t.payoutDestination).not.toContain('000011112222');
  });
});

describe('listByIdsScoped', () => {
  it('returns only rows in scope', async () => {
    const repo = createTransferRepo(db);
    const d = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1 });
    const p = await seedLedgerSpend(db, { partnerId: 'p2', phone: PHONE, amountUsd: 1 });
    expect((await repo.listByIdsScoped([d, p], 'p2')).map((t) => t.id)).toEqual([p]);
    expect((await repo.listByIdsScoped([d, p])).map((t) => t.id).sort()).toEqual([d, p].sort());
    expect(await repo.listByIdsScoped([])).toEqual([]);
  });
});
