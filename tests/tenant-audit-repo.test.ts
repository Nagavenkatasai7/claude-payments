import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import { listTenantAudit, listTenantAuditForSubject } from '@/db/repos/tenant-audit-repo';

// UI redesign M3-4: the tenant audit read. The partner id is ALWAYS in the WHERE, the action list is
// an IN filter (empty = no query), and paging is keyset on (at, id) newest first.
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
let db: Db;

async function insert(o: { partnerId: string | null; action: string; actor?: string; subjectId?: string; at?: Date; meta?: unknown }) {
  const [r] = await db
    .insert(auditEvents)
    .values({
      partnerId: o.partnerId,
      actor: o.actor ?? 'someone',
      actorType: 'staff',
      action: o.action,
      subjectId: o.subjectId ?? null,
      meta: o.meta ?? null,
      at: o.at ?? new Date(),
    })
    .returning({ id: auditEvents.id });
  return r.id;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
});

describe('listTenantAudit', () => {
  it('returns only partner A rows, only allowlisted actions, newest first, keyset-paged', async () => {
    for (let i = 1; i <= 3; i++) await insert({ partnerId: 'pa', action: 'api_key.issue', at: daysAgo(i) });
    await insert({ partnerId: 'pa', action: 'created', at: daysAgo(4) });
    await insert({ partnerId: 'pa', action: 'sanctions.screen', at: daysAgo(1) });
    for (let i = 1; i <= 3; i++) await insert({ partnerId: 'pb', action: 'api_key.issue', at: daysAgo(i) });
    await insert({ partnerId: null, action: 'api_key.issue', at: daysAgo(1) });

    const q = { actions: ['api_key.issue', 'created'], from: daysAgo(30), to: new Date(), limit: 2 };
    const page1 = await listTenantAudit(db, 'pa', q);
    expect(page1).toHaveLength(2);
    expect(page1.every((r) => r.action !== 'sanctions.screen')).toBe(true);
    const foreign = new Set(
      (await db.select().from(auditEvents).where(sql`${auditEvents.partnerId} IS DISTINCT FROM 'pa'`)).map((r) => r.id),
    );
    expect(page1.some((r) => foreign.has(r.id))).toBe(false);
    expect(page1[0].at.getTime()).toBeGreaterThan(page1[1].at.getTime());

    const page2 = await listTenantAudit(db, 'pa', { ...q, before: { at: page1[1].at, id: page1[1].id } });
    expect(page2.map((r) => r.id)).not.toContain(page1[0].id);
    expect(page2.map((r) => r.id)).not.toContain(page1[1].id);
    const all = [...page1, ...page2];
    expect(all.map((r) => r.action).sort()).toEqual(['api_key.issue', 'api_key.issue', 'api_key.issue', 'created']);
    expect(all.some((r) => foreign.has(r.id))).toBe(false);
  });

  it('an empty action list runs no query and returns []', async () => {
    await insert({ partnerId: 'pa', action: 'api_key.issue' });
    expect(await listTenantAudit(db, 'pa', { actions: [], from: daysAgo(1), to: new Date(), limit: 10 })).toEqual([]);
  });

  it('a cursor taken from another tenant row never returns that tenant', async () => {
    const pbId = await insert({ partnerId: 'pb', action: 'api_key.issue', at: daysAgo(1) });
    await insert({ partnerId: 'pb', action: 'api_key.issue', at: daysAgo(2) });
    await insert({ partnerId: 'pa', action: 'api_key.issue', at: daysAgo(3) });
    const [pbRow] = await db.select().from(auditEvents).where(eq(auditEvents.id, pbId));
    const rows = await listTenantAudit(db, 'pa', {
      actions: ['api_key.issue'],
      from: daysAgo(30),
      to: new Date(),
      limit: 10,
      before: { at: pbRow.at, id: pbRow.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.id !== pbId)).toBe(true);
  });

  it('the actor filter and the date window are applied in SQL', async () => {
    await insert({ partnerId: 'pa', action: 'created', actor: 'pa-admin', at: daysAgo(2) });
    await insert({ partnerId: 'pa', action: 'created', actor: 'pa-ops', at: daysAgo(2) });
    await insert({ partnerId: 'pa', action: 'created', actor: 'pa-admin', at: daysAgo(40) });
    const rows = await listTenantAudit(db, 'pa', { actions: ['created'], actor: 'pa-admin', from: daysAgo(30), to: new Date(), limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('pa-admin');
  });

  it('rows in the same millisecond (sub-millisecond apart) are neither skipped nor repeated across pages', async () => {
    // timestamptz keeps microseconds; a JS Date keeps milliseconds. A cursor built from the Date
    // must still page through rows written in one transaction (same now()).
    await db.execute(sql`
      INSERT INTO audit_events (partner_id, actor, actor_type, action, at) VALUES
        ('pa', 'a', 'staff', 'created', date_trunc('milliseconds', now() - interval '1 day') + interval '100 microseconds'),
        ('pa', 'a', 'staff', 'created', date_trunc('milliseconds', now() - interval '1 day') + interval '300 microseconds'),
        ('pa', 'a', 'staff', 'created', date_trunc('milliseconds', now() - interval '1 day') + interval '200 microseconds'),
        ('pa', 'a', 'staff', 'created', date_trunc('milliseconds', now() - interval '1 day'))`);
    const expected = (await db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id).sort();
    const seen: number[] = [];
    let before: { at: Date; id: number } | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await listTenantAudit(db, 'pa', { actions: ['created'], from: daysAgo(30), to: new Date(), limit: 1, before });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      before = { at: page[page.length - 1].at, id: page[page.length - 1].id };
    }
    expect([...seen].sort()).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('the limit is clamped to 1..100', async () => {
    for (let i = 0; i < 3; i++) await insert({ partnerId: 'pa', action: 'created', at: daysAgo(1) });
    expect(await listTenantAudit(db, 'pa', { actions: ['created'], from: daysAgo(30), to: new Date(), limit: 0 })).toHaveLength(1);
    expect(await listTenantAudit(db, 'pa', { actions: ['created'], from: daysAgo(30), to: new Date(), limit: 10_000 })).toHaveLength(3);
  });

  it('an empty partner id returns [] (never an unscoped read)', async () => {
    await insert({ partnerId: 'pa', action: 'created' });
    expect(await listTenantAudit(db, '', { actions: ['created'], from: daysAgo(30), to: new Date(), limit: 10 })).toEqual([]);
  });
});

describe('listTenantAuditForSubject', () => {
  it('returns only this tenant rows for the subject, allowlisted actions only, newest first', async () => {
    await insert({ partnerId: 'pa', action: 'transfer.release', subjectId: 'tx1', at: daysAgo(2) });
    await insert({ partnerId: 'pa', action: 'transfer.hold.note', subjectId: 'tx1', at: daysAgo(1) });
    await insert({ partnerId: 'pa', action: 'sanctions.screen', subjectId: 'tx1', at: daysAgo(1) });
    await insert({ partnerId: 'pa', action: 'transfer.release', subjectId: 'tx2', at: daysAgo(1) });
    const pbId = await insert({ partnerId: 'pb', action: 'transfer.release', subjectId: 'tx1', at: daysAgo(1) });
    const rows = await listTenantAuditForSubject(db, 'pa', 'tx1', ['transfer.release', 'transfer.hold.note'], 10);
    expect(rows.map((r) => r.action)).toEqual(['transfer.hold.note', 'transfer.release']);
    expect(rows.every((r) => r.id !== pbId && r.subjectId === 'tx1')).toBe(true);
  });
  it('an empty action list, subject or partner id returns []', async () => {
    await insert({ partnerId: 'pa', action: 'transfer.release', subjectId: 'tx1' });
    expect(await listTenantAuditForSubject(db, 'pa', 'tx1', [], 10)).toEqual([]);
    expect(await listTenantAuditForSubject(db, 'pa', '', ['transfer.release'], 10)).toEqual([]);
    expect(await listTenantAuditForSubject(db, '', 'tx1', ['transfer.release'], 10)).toEqual([]);
  });
});
