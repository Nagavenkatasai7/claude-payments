import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { seedTwoTenants, seedPartnerTransfer } from './helpers-partner-app';
import type { Db } from '@/db/client';
import { partnerReportJobs } from '@/db/schema';
import { LEASE_MS } from '@/db/repos/outbox-repo';
import { createPartnerReportRepo } from '@/db/repos/partner-report-repo';

// UI redesign M3-16, Task 16.2: the partner report job repo + its tenant-required ledger reads.

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedTwoTenants(db);
});

const NOW = () => new Date();

async function job(partnerId: string, over: Partial<typeof partnerReportJobs.$inferInsert> = {}) {
  const id = randomUUID();
  await createPartnerReportRepo(db).createJob(partnerId, { id, kind: 'settlements', params: { from: 'a', to: 'b' }, requestedBy: 'u1' });
  if (Object.keys(over).length) await db.update(partnerReportJobs).set(over).where(eq(partnerReportJobs.id, id));
  return id;
}

describe('tenant scoping', () => {
  it('get/list are tenant-scoped; a foreign id is null; the list never carries content', async () => {
    const repo = createPartnerReportRepo(db);
    const a = await job('pa', { contentEnc: 'v2.sealed', status: 'ready' });
    const b = await job('pb');
    expect((await repo.getJobForPartner('pa', a))?.id).toBe(a);
    expect(await repo.getJobForPartner('pa', b)).toBeNull();
    expect(await repo.getJobForPartner('pb', a)).toBeNull();
    const list = await repo.listJobs('pa');
    expect(list.map((j) => j.id)).toEqual([a]);
    expect(JSON.stringify(list)).not.toContain('v2.sealed');
    expect(Object.keys(list[0])).not.toContain('contentEnc');
  });

  it('refuses an empty tenant', async () => {
    const repo = createPartnerReportRepo(db);
    await expect(repo.listJobs('')).rejects.toThrow(/tenant/);
    await expect(repo.getJobForPartner('', randomUUID())).rejects.toThrow(/tenant/);
    await expect(repo.createJob('', { id: randomUUID(), kind: 'settlements', params: {}, requestedBy: 'u' })).rejects.toThrow(/tenant/);
  });

  it('counts active (recent queued/running) and recent jobs per tenant only', async () => {
    const repo = createPartnerReportRepo(db);
    await job('pa');
    await job('pa', { status: 'running' });
    await job('pa', { status: 'ready' });
    await job('pa', { createdAt: new Date(Date.now() - 2 * 3_600_000) }); // stale queued: not active
    await job('pb');
    const since = new Date(Date.now() - 3_600_000);
    expect(await repo.countActive('pa', since)).toBe(2);
    expect(await repo.countSince('pa', new Date(Date.now() - 86_400_000))).toBe(4);
    expect(await repo.countActive('pb', since)).toBe(1);
  });
});

describe('claimJob', () => {
  it('is single-winner under two concurrent claims', async () => {
    const repo = createPartnerReportRepo(db);
    const id = await job('pa');
    const now = NOW();
    const [x, y] = await Promise.all([repo.claimJob(id, now), createPartnerReportRepo(db).claimJob(id, now)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const row = (await db.select().from(partnerReportJobs).where(eq(partnerReportJobs.id, id)))[0];
    expect(row.status).toBe('running');
    expect(row.claimedAt?.getTime()).toBe(now.getTime());
  });

  it('never claims a ready/failed/expired job, nor a fresh running one', async () => {
    const repo = createPartnerReportRepo(db);
    for (const status of ['ready', 'failed', 'expired']) expect(await repo.claimJob(await job('pa', { status }), NOW())).toBeNull();
    expect(await repo.claimJob(await job('pa', { status: 'running', claimedAt: new Date() }), NOW())).toBeNull();
  });

  it('reclaims a stale running job exactly once', async () => {
    const repo = createPartnerReportRepo(db);
    const id = await job('pa', { status: 'running', claimedAt: new Date(Date.now() - LEASE_MS - 1000) });
    const first = await repo.claimJob(id, NOW());
    expect(first?.id).toBe(id);
    expect(await repo.claimJob(id, NOW())).toBeNull();
  });

  it('complete/fail are compare-and-set on the claim', async () => {
    const repo = createPartnerReportRepo(db);
    const id = await job('pa');
    const claim = (await repo.claimJob(id, NOW()))!;
    expect(await repo.completeJob(id, new Date(claim.claimedAt.getTime() + 1), { contentEnc: 'x', rowCount: 1, params: {}, expiresAt: new Date() })).toBe(false);
    expect(await repo.failJob(id, new Date(0), 'generation_failed')).toBe(false);
    const expiresAt = new Date(Date.now() + 1000);
    expect(await repo.completeJob(id, claim.claimedAt, { contentEnc: 'x', rowCount: 3, params: { truncated: true }, expiresAt })).toBe(true);
    const row = (await repo.getJobForPartner('pa', id))!;
    expect(row).toMatchObject({ status: 'ready', rowCount: 3, contentEnc: 'x', params: { truncated: true } });
    expect(await repo.failJob(id, claim.claimedAt, 'generation_failed')).toBe(false); // no longer running
  });
});

describe('expireDue', () => {
  it('nulls the content only for past-due ready rows', async () => {
    const repo = createPartnerReportRepo(db);
    const past = await job('pa', { status: 'ready', contentEnc: 'old', expiresAt: new Date(Date.now() - 1000) });
    const future = await job('pb', { status: 'ready', contentEnc: 'new', expiresAt: new Date(Date.now() + 3_600_000) });
    const queued = await job('pa');
    expect(await repo.expireDue(NOW())).toBe(1);
    const get = async (id: string) => (await db.select().from(partnerReportJobs).where(eq(partnerReportJobs.id, id)))[0];
    expect(await get(past)).toMatchObject({ status: 'expired', contentEnc: null });
    expect(await get(future)).toMatchObject({ status: 'ready', contentEnc: 'new' });
    expect(await get(queued)).toMatchObject({ status: 'queued' });
  });
});

describe('ledger reads', () => {
  it('transfersForExport: tenant, environment, status and created_at window; masked rows', async () => {
    const at = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    await seedPartnerTransfer(db, { id: 'tx_a1', partnerId: 'pa', createdAt: at(1) });
    await seedPartnerTransfer(db, { id: 'tx_a2', partnerId: 'pa', createdAt: at(2), status: 'delivered' });
    await seedPartnerTransfer(db, { id: 'tx_a3', partnerId: 'pa', createdAt: at(40) });
    await seedPartnerTransfer(db, { id: 'tx_a4', partnerId: 'pa', createdAt: at(1), environment: 'test' });
    await seedPartnerTransfer(db, { id: 'tx_b1', partnerId: 'pb', createdAt: at(1) });
    const repo = createPartnerReportRepo(db);
    const w = { from: new Date(Date.now() - 31 * 86_400_000), to: new Date(Date.now() + 86_400_000), environment: 'live' as const };
    const p1 = await repo.transfersForExport('pa', { ...w, limit: 1 });
    expect(p1.items.map((t) => t.id)).toEqual(['tx_a1']);
    const p2 = await repo.transfersForExport('pa', { ...w, limit: 1, cursor: p1.nextCursor });
    expect(p2.items.map((t) => t.id)).toEqual(['tx_a2']);
    expect(p2.nextCursor).toBeUndefined();
    expect((await repo.transfersForExport('pa', { ...w, limit: 10, status: 'delivered' })).items.map((t) => t.id)).toEqual(['tx_a2']);
    expect((await repo.transfersForExport('pa', { ...w, limit: 10, environment: 'test' })).items.map((t) => t.id)).toEqual(['tx_a4']);
    expect(p1.items[0].payoutDestination).toMatch(/^\*{4}/);
    await expect(repo.transfersForExport('', { ...w, limit: 1 })).rejects.toThrow(/tenant/);
  });

  it('feesByDay: live paid/delivered rows of the tenant, per UTC day and currency', async () => {
    const d1 = '2026-08-03T10:00:00.000Z';
    await seedPartnerTransfer(db, { id: 'tx_f1', partnerId: 'pa', createdAt: d1, status: 'paid', feeSource: 2, feeUsd: 2, amountSource: 100 });
    await seedPartnerTransfer(db, { id: 'tx_f2', partnerId: 'pa', createdAt: d1, status: 'delivered', feeSource: 3.5, feeUsd: 3.5, amountSource: 50.25 });
    await seedPartnerTransfer(db, { id: 'tx_f3', partnerId: 'pa', createdAt: d1, status: 'cancelled', feeSource: 9, feeUsd: 9 });
    await seedPartnerTransfer(db, { id: 'tx_f4', partnerId: 'pa', createdAt: d1, status: 'paid', environment: 'test', feeSource: 9, feeUsd: 9 });
    await seedPartnerTransfer(db, { id: 'tx_f5', partnerId: 'pb', createdAt: d1, status: 'paid', feeSource: 9, feeUsd: 9 });
    await seedPartnerTransfer(db, { id: 'tx_f6', partnerId: 'pa', createdAt: '2026-09-01T00:00:00.000Z', status: 'paid', feeSource: 9, feeUsd: 9 });
    const rows = await createPartnerReportRepo(db).feesByDay('pa', new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    expect(rows).toEqual([{ day: '2026-08-03', currency: 'USD', transfers: 2, amountSource: 150.25, feeSource: 5.5, feeUsd: 5.5 }]);
  });
});
