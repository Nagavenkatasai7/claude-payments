import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createTransferRepo, escapeLike, PORTAL_STATUS_GROUPS } from '@/db/repos/transfer-repo';
import { getPortalTransfer, listPortalTransfers } from '@/lib/portal-transfers';
import { freshDb, seedLedgerSpend } from './helpers-db';
import { seedTwoPartners, type TwoPartnerFixture } from './helpers-portal-two-partner';

// UI redesign M2-7, Task 7.1: the customer portal's transfer reads are scoped to the HOST partner
// AND the session phone (404-never-403), LIVE rows only, masked by default, with a literal-only
// search and a stable keyset second page.

const OTHER_PHONE = '14155550199';

let db: Db;
let A: TwoPartnerFixture;
let B: TwoPartnerFixture;
let phone: string;
let otherPhoneTx: string;
const ownerA = () => ({ partnerId: 'pa', phone });

beforeEach(async () => {
  db = await freshDb();
  ({ A, B, phone } = await seedTwoPartners(db));
  otherPhoneTx = await seedLedgerSpend(db, { partnerId: 'pa', phone: OTHER_PHONE, amountUsd: 77, status: 'paid' });
});

describe('listPortalTransfers (tenant + phone)', () => {
  it("A's list on A's session shows A's 2 transfers only (not B's, not another phone's)", async () => {
    const page = await listPortalTransfers(ownerA(), { limit: 20 }, db);
    expect(page.items.map((r) => r.id).sort()).toEqual([...A.transferIds].sort());
    for (const id of [...B.transferIds, otherPhoneTx]) expect(page.items.some((r) => r.id === id)).toBe(false);
  });
  it('rows are masked: the full payout account never appears', async () => {
    const page = await listPortalTransfers(ownerA(), { limit: 20 }, db);
    const json = JSON.stringify(page);
    expect(json).not.toContain('000011112222');
    for (const r of page.items) expect(r.maskedDestination).toMatch(/^\*{4}/);
  });
  it('sandbox rows never appear (LIVE only, like listByPhone)', async () => {
    const [row] = (await createTransferRepo(db).listByPhone('pa', phone, { limit: 1 })).items;
    const sandboxId = 'sbx_portal_test_1';
    await createTransferRepo(db).saveTransfer({ ...row, id: sandboxId, environment: 'test', payoutDestination: '000011112222|HDFC0000001' });
    const page = await listPortalTransfers(ownerA(), { limit: 20 }, db);
    expect(page.items.some((r) => r.id === sandboxId)).toBe(false);
    expect(await getPortalTransfer(ownerA(), sandboxId, db)).toBeNull();
  });
});

describe('getPortalTransfer (404-never-403)', () => {
  it("A's own transfer resolves, masked", async () => {
    const t = await getPortalTransfer(ownerA(), A.transferIds[0], db);
    expect(t?.id).toBe(A.transferIds[0]);
    expect(t?.payoutDestination).toMatch(/^\*{4}/);
  });
  it("B's transfer id on A's session → null (the same shape as missing)", async () => {
    expect(await getPortalTransfer(ownerA(), B.transferIds[0], db)).toBeNull();
    expect(await getPortalTransfer(ownerA(), 'does-not-exist', db)).toBeNull();
  });
  it("another phone's transfer in the SAME partner → null", async () => {
    expect(await getPortalTransfer(ownerA(), otherPhoneTx, db)).toBeNull();
  });
  it('junk ids → null without a query error', async () => {
    for (const id of ['', ' ', '%', 'a'.repeat(200)]) expect(await getPortalTransfer(ownerA(), id, db)).toBeNull();
  });
});

describe('search and filters', () => {
  it("q='%' and q='_' return nothing extra (escaped)", async () => {
    expect((await listPortalTransfers(ownerA(), { limit: 20, q: '%' }, db)).items).toEqual([]);
    expect((await listPortalTransfers(ownerA(), { limit: 20, q: '_' }, db)).items).toEqual([]);
    expect((await listPortalTransfers(ownerA(), { limit: 20, q: '\\' }, db)).items).toEqual([]);
  });
  it('a literal % in a recipient name is found by q=%', async () => {
    const [row] = (await createTransferRepo(db).listByPhone('pa', phone, { limit: 1 })).items;
    await createTransferRepo(db).saveTransfer({ ...row, id: 'pct_name_1', recipientName: '100% Kumar', payoutDestination: '000011112222|HDFC0000001' });
    expect((await listPortalTransfers(ownerA(), { limit: 20, q: '%' }, db)).items.map((r) => r.id)).toEqual(['pct_name_1']);
  });
  it('matches the recipient name case-insensitively, or an id prefix; trimmed', async () => {
    expect((await listPortalTransfers(ownerA(), { limit: 20, q: '  seeded REC ' }, db)).items).toHaveLength(2);
    const id = A.transferIds[0];
    expect((await listPortalTransfers(ownerA(), { limit: 20, q: id.slice(0, 8) }, db)).items.map((r) => r.id)).toEqual([id]);
  });
  it("search never reaches B's rows", async () => {
    const id = B.transferIds[0];
    expect((await listPortalTransfers(ownerA(), { limit: 20, q: id.slice(0, 10) }, db)).items).toEqual([]);
  });
  it('status groups: completed = delivered, in_progress = paid, refunded = refund completed (and leaves its base group)', async () => {
    const [paidId, deliveredId] = A.transferIds;
    expect((await listPortalTransfers(ownerA(), { limit: 20, status: 'completed' }, db)).items.map((r) => r.id)).toEqual([deliveredId]);
    expect((await listPortalTransfers(ownerA(), { limit: 20, status: 'in_progress' }, db)).items.map((r) => r.id)).toEqual([paidId]);
    expect((await listPortalTransfers(ownerA(), { limit: 20, status: 'refunded' }, db)).items).toEqual([]);
    await db.execute(sql`UPDATE transfers SET refund_status = 'completed' WHERE id = ${paidId}`);
    expect((await listPortalTransfers(ownerA(), { limit: 20, status: 'refunded' }, db)).items.map((r) => r.id)).toEqual([paidId]);
    expect((await listPortalTransfers(ownerA(), { limit: 20, status: 'in_progress' }, db)).items).toEqual([]);
  });
  it('the group mapping is pinned', () => {
    expect(PORTAL_STATUS_GROUPS).toEqual({
      in_progress: ['awaiting_payment', 'paid', 'in_review'],
      completed: ['delivered'],
      cancelled: ['cancelled', 'blocked'],
    });
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });
});

describe('keyset pagination', () => {
  it('returns a stable second page with no overlap and no gap', async () => {
    for (let i = 0; i < 5; i++) {
      await seedLedgerSpend(db, { partnerId: 'pa', phone, amountUsd: 10 + i, status: 'paid', createdAt: new Date(Date.now() - (i + 3) * 3_600_000) });
    }
    const all = (await listPortalTransfers(ownerA(), { limit: 50 }, db)).items.map((r) => r.id);
    expect(all).toHaveLength(7);
    const p1 = await listPortalTransfers(ownerA(), { limit: 3 }, db);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listPortalTransfers(ownerA(), { limit: 3, cursor: p1.nextCursor }, db);
    const p2again = await listPortalTransfers(ownerA(), { limit: 3, cursor: p1.nextCursor }, db);
    expect(p2again.items.map((r) => r.id)).toEqual(p2.items.map((r) => r.id));
    const p3 = await listPortalTransfers(ownerA(), { limit: 3, cursor: p2.nextCursor }, db);
    expect([...p1.items, ...p2.items, ...p3.items].map((r) => r.id)).toEqual(all);
    expect(p3.nextCursor).toBeUndefined();
  });
  it('a malformed cursor falls back to the first page', async () => {
    const p = await listPortalTransfers(ownerA(), { limit: 20, cursor: 'garbage' }, db);
    expect(p.items).toHaveLength(2);
  });
});
