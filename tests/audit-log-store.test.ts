import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers-db';
import { createAuditLogStore, type StaffAuditEntry } from '@/lib/audit-log-store';
import { createAuditRepo } from '@/db/repos/aux-repos';

// audit-log-store — Postgres-backed (audit_events, actor_type 'staff'). The
// `at` on a listed entry is the DB's now() at insert time, NOT the value the
// caller provided — so we assert presence/order/contents, never an exact at.

function entry(i: number, detail?: string): StaffAuditEntry {
  const e: StaffAuditEntry = {
    at: '2026-06-01T00:00:00.000Z', // ignored on write — at comes from DB now()
    actor: 'boss',
    action: 'created',
    target: `u${i}`,
  };
  if (detail) e.detail = detail;
  return e;
}

/** Tiny gap so consecutive rows get strictly increasing DB now() timestamps. */
const tick = () => new Promise((r) => setTimeout(r, 2));

describe('audit-log-store (Postgres)', () => {
  it('records newest-first and round-trips actor/action/target', async () => {
    const s = createAuditLogStore(await freshDb());
    await s.record(entry(1));
    await tick();
    await s.record(entry(2));
    const log = await s.list();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ actor: 'boss', action: 'created', target: 'u2' }); // newest first
    expect(log[1]).toMatchObject({ actor: 'boss', action: 'created', target: 'u1' });
    // `at` is assigned by the DB — present, ISO, and non-increasing down the list.
    for (const e of log) expect(new Date(e.at).getTime()).not.toBeNaN();
    expect(new Date(log[0].at).getTime()).toBeGreaterThanOrEqual(new Date(log[1].at).getTime());
  });

  it('round-trips the optional detail (and omits it when absent)', async () => {
    const s = createAuditLogStore(await freshDb());
    await s.record(entry(1, 'role admin → agent'));
    await tick();
    await s.record(entry(2));
    const log = await s.list();
    expect(log[0].detail).toBeUndefined();
    expect(log[1].detail).toBe('role admin → agent');
  });

  it('respects the list limit', async () => {
    const s = createAuditLogStore(await freshDb());
    for (let i = 0; i < 10; i++) {
      await s.record(entry(i));
      await tick();
    }
    expect(await s.list(3)).toHaveLength(3);
    expect((await s.list(3))[0].target).toBe('u9'); // most recent first
  });

  it('returns an empty array when there is no history', async () => {
    const s = createAuditLogStore(await freshDb());
    expect(await s.list()).toEqual([]);
  });

  it('Program-Fix 14: high-volume system rows (one sanctions.screen per mint) never crowd staff entries out of the list', async () => {
    const db = await freshDb();
    const s = createAuditLogStore(db);
    for (let i = 0; i < 3; i++) {
      await s.record(entry(i));
      await tick();
    }
    const repo = createAuditRepo(db);
    for (let i = 0; i < 60; i++) {
      await repo.record({ partnerId: 'default', actor: 'system:sanctions', actorType: 'system', action: 'sanctions.screen', subjectId: `t${i}`, meta: {} });
    }
    const log = await s.list(50);
    expect(log.map((e) => e.target)).toEqual(['u2', 'u1', 'u0']);
  });

  it('partner-demo R5: records the tenant and actor scope when given; listForPartner is tenant-scoped and staff created/removed only', async () => {
    const db = await freshDb();
    const s = createAuditLogStore(db);
    await s.record({ ...entry(1), partnerId: 'acme', actorScope: 'partner', actor: 'acme-admin' });
    await tick();
    await s.record({ ...entry(2), partnerId: 'beta', actorScope: 'partner', actor: 'beta-admin' });
    await tick();
    await s.record({ ...entry(3), action: 'updated', partnerId: 'acme' });
    await tick();
    await s.record({ ...entry(4), action: 'removed', partnerId: 'acme', actorScope: 'platform', actor: 'ops' });
    await tick();
    await s.record(entry(5)); // platform row, no tenant
    // a non-staff row for the tenant (e.g. a pii.view) never shows in the feed
    await createAuditRepo(db).record({ partnerId: 'acme', actor: 'ops', actorType: 'staff', action: 'pii.view', subjectId: 'x' });
    await createAuditRepo(db).record({ partnerId: 'acme', actor: 'system:x', actorType: 'system', action: 'created', subjectId: 'y' });

    const acme = await s.listForPartner('acme');
    expect(acme.map((e) => [e.target, e.action, e.actorScope])).toEqual([
      ['u4', 'removed', 'platform'],
      ['u1', 'created', 'partner'],
    ]);
    expect((await s.listForPartner('beta')).map((e) => e.target)).toEqual(['u2']);
    expect(await s.listForPartner('')).toEqual([]);

    // the stored row carries partner_id; the Team feed still lists every staff change
    const rows = await createAuditRepo(db).listByPartner('acme');
    expect(rows.filter((r) => r.actorType === 'staff' && r.subjectId === 'u1')[0]?.partnerId).toBe('acme');
    expect((await s.list()).map((e) => e.target)).toEqual(['u5', 'u4', 'u3', 'u2', 'u1']);
  });
});
