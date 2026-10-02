import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { RefundStatus, Transfer } from '@/lib/types';

// Merge plan 2b hardening of the ONE refund money path (dashboard-ops approve / dismiss / retry),
// which /partner/refunds reuses:
//  - an optional tenant: the in-transaction reload is scoped to it, so a foreign id is refused with
//    nothing written (existing callers pass nothing and are unchanged);
//  - a lost race: when the guarded refund-status write claims nothing (another decision committed
//    after this call's read), the call throws and rolls back: no second funding.refund effect and
//    no audit row for a decision that did not happen;
//  - the audit row records the caller's actor scope when one is given.

// A switch that makes the transfer reads inside these functions return a STALE refund status (the
// state as it was before a concurrent decision committed), to reproduce the read → write window.
const stale: { status: RefundStatus | null } = { status: null };
vi.mock('@/db/repos/transfer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/transfer-repo')>();
  return {
    ...real,
    createTransferRepo: (...a: Parameters<typeof real.createTransferRepo>) => {
      const r = real.createTransferRepo(...a);
      const staleOf = (t: Transfer | null) => (t && stale.status ? { ...t, refundStatus: stale.status } : t);
      return {
        ...r,
        getTransfer: async (...g: Parameters<typeof r.getTransfer>) => staleOf(await r.getTransfer(...g)),
        getOwnedTransfer: async (...g: Parameters<typeof r.getOwnedTransfer>) => staleOf(await r.getOwnedTransfer(...g)),
      };
    },
  };
});
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: vi.fn() }));

import { approveRefund, dismissRefund, retryRefund } from '@/lib/dashboard-ops';

let db: Db;
beforeEach(async () => {
  stale.status = null;
  db = await freshDb();
  await seedTwoTenants(db);
});

const rowsOf = async <T,>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;
const refundStatus = async (id: string) => (await rowsOf<{ refund_status: string }>(sql`SELECT refund_status FROM transfers WHERE id = ${id}`))[0].refund_status;
const refundEffects = () => rowsOf<{ dedupe_key: string }>(sql`SELECT dedupe_key FROM outbox WHERE kind = 'funding.refund' ORDER BY id`);
const audits = () => rowsOf<{ action: string; partner_id: string; meta: Record<string, unknown> }>(sql`SELECT action, partner_id, meta FROM audit_events ORDER BY id`);
const seed = (id: string, partnerId: string, rs: RefundStatus) => seedPartnerTransfer(db, { id, partnerId, status: 'cancelled', fundingRef: `f-${id}`, refundStatus: rs });
const AUDIT = { actor: 'pa-admin', reason: 'customer confirmed the request' };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('optional tenant scope', () => {
  it('approve: a foreign tenant is refused with nothing written; the owner tenant succeeds', async () => {
    await seed('t1', 'pa', 'requested');
    await expect(approveRefund(db, 't1', AUDIT, { partnerId: 'pb' })).rejects.toThrow(/not awaiting approval/);
    expect(await refundStatus('t1')).toBe('requested');
    expect(await refundEffects()).toEqual([]);
    expect(await audits()).toEqual([]);
    await approveRefund(db, 't1', AUDIT, { partnerId: 'pa' });
    expect(await refundStatus('t1')).toBe('pending');
    expect(await refundEffects()).toEqual([{ dedupe_key: 'refund:t1' }]);
  });
  it('dismiss: a foreign tenant is refused with nothing written (no note, no audit)', async () => {
    await seed('t2', 'pa', 'requested');
    await expect(dismissRefund(db, 't2', AUDIT, { partnerId: 'pb' })).rejects.toThrow(/not awaiting approval/);
    expect(await refundStatus('t2')).toBe('requested');
    expect((await rowsOf<{ admin_note: string | null }>(sql`SELECT admin_note FROM transfers WHERE id = 't2'`))[0].admin_note ?? '').not.toContain('dismissed');
    expect(await audits()).toEqual([]);
    await dismissRefund(db, 't2', AUDIT, { partnerId: 'pa' });
    expect(await refundStatus('t2')).toBe('none');
  });
  it('retry: a foreign tenant is refused with nothing written', async () => {
    await seed('t3', 'pa', 'failed');
    await expect(retryRefund(db, 't3', AUDIT, { partnerId: 'pb' })).rejects.toThrow(/not in a failed state/);
    expect(await refundStatus('t3')).toBe('failed');
    expect(await refundEffects()).toEqual([]);
    await retryRefund(db, 't3', AUDIT, { partnerId: 'pa' });
    expect(await refundStatus('t3')).toBe('pending');
    expect(await refundEffects()).toHaveLength(1);
  });
});

describe('lost race (the guarded write claims nothing)', () => {
  it('retry: a second retry that read the stale failed state throws; exactly ONE funding.refund effect', async () => {
    await seed('r1', 'pa', 'failed');
    await retryRefund(db, 'r1', AUDIT); // the winner
    await tick(); // a distinct retry key, so only the state guard can stop a second effect
    stale.status = 'failed';
    await expect(retryRefund(db, 'r1', AUDIT)).rejects.toThrow(/not in a failed state/);
    stale.status = null;
    expect(await refundStatus('r1')).toBe('pending');
    expect(await refundEffects()).toHaveLength(1);
    expect((await audits()).map((a) => a.action)).toEqual(['refund.retry']);
  });
  it('approve: a second approve that read the stale requested state throws; one effect, one audit row', async () => {
    await seed('r2', 'pa', 'requested');
    await approveRefund(db, 'r2', AUDIT);
    stale.status = 'requested';
    await expect(approveRefund(db, 'r2', AUDIT)).rejects.toThrow(/not awaiting approval/);
    stale.status = null;
    expect(await refundStatus('r2')).toBe('pending');
    expect(await refundEffects()).toEqual([{ dedupe_key: 'refund:r2' }]);
    expect((await audits()).map((a) => a.action)).toEqual(['refund.approve']);
  });
});

describe('actor scope in the audit row', () => {
  it('is recorded when given and absent otherwise', async () => {
    await seed('s1', 'pa', 'requested');
    await seed('s2', 'pa', 'requested');
    await approveRefund(db, 's1', { ...AUDIT, actorScope: 'partner' }, { partnerId: 'pa' });
    await approveRefund(db, 's2', AUDIT);
    const [a, b] = await audits();
    expect(a).toMatchObject({ action: 'refund.approve', partner_id: 'pa', meta: { actorScope: 'partner', reason: AUDIT.reason, refundStatus: 'pending' } });
    expect(b.meta).not.toHaveProperty('actorScope');
  });
});
