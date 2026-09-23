import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { scopeOf } from '@/lib/staff-scope';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Program-Fix 43 (compliance-09, partial): the AML review item. The action is
// a PUBLIC POST endpoint: it self-gates (requireScope), loads the alert by id
// PINNED to the staff member's tenant (a miss and another tenant's alert are the
// same 'Alert not found'), refuses any audit row that is not an `aml.alert`,
// and writes ONE `aml.reviewed` row per alert.

let currentStaff: Staff | null;
let db: Db;

vi.mock('@/lib/auth', () => ({
  requireScope: async () => {
    if (!currentStaff) throw new Error('REDIRECT:/login');
    if (currentStaff.role === 'support') throw new Error('REDIRECT:/admin-dashboard/tickets');
    return { staff: currentStaff, scope: scopeOf(currentStaff) };
  },
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { reviewAmlAlertAction } from '@/app/admin-dashboard/compliance/actions';

function staff(over: Partial<Staff> = {}): Staff {
  return {
    username: 'root', name: 'Root', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function rows(action: string) {
  const r = await db.execute(sql`SELECT id, partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = ${action} ORDER BY id`);
  return r.rows as Array<{ id: number; partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }>;
}

async function seedAlert(partnerId: string, transferId: string): Promise<number> {
  await createAuditRepo(db).record({
    partnerId, actor: 'system', actorType: 'system', action: 'aml.alert', subjectId: transferId,
    meta: { rule: 'structuring', window: '7d', count: 3, sumUsd: 2700 },
  });
  const r = await db.execute(sql`SELECT max(id)::int AS id FROM audit_events`);
  return (r.rows[0] as { id: number }).id;
}

let alertA: number;
let alertB: number;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  alertA = await seedAlert('A', 'tr_a');
  alertB = await seedAlert('B', 'tr_b');
  currentStaff = staff();
});

describe('reviewAmlAlertAction', () => {
  it('unauthenticated is refused before any read or write', async () => {
    currentStaff = null;
    await expect(reviewAmlAlertAction(form({ alertId: String(alertA), disposition: 'no_action' }))).rejects.toThrow('REDIRECT:/login');
    expect(await rows('aml.reviewed')).toEqual([]);
  });

  it('support role is refused', async () => {
    currentStaff = staff({ role: 'support' });
    await expect(reviewAmlAlertAction(form({ alertId: String(alertA), disposition: 'no_action' }))).rejects.toThrow('REDIRECT');
    expect(await rows('aml.reviewed')).toEqual([]);
  });

  it("partner-A staff reviewing partner B's alert gets 'Alert not found'; nothing written", async () => {
    currentStaff = staff({ username: 'a-agent', role: 'agent', partnerId: 'A' });
    await expect(reviewAmlAlertAction(form({ alertId: String(alertB), disposition: 'no_action' }))).rejects.toThrow('Alert not found');
    expect(await rows('aml.reviewed')).toEqual([]);
  });

  it('an audit row that is not an aml.alert is "Alert not found" (no reviews attached to arbitrary rows)', async () => {
    await createAuditRepo(db).record({ partnerId: 'A', actor: 'x', actorType: 'staff', action: 'transfer.released', subjectId: 'tr_a' });
    const r = await db.execute(sql`SELECT max(id)::int AS id FROM audit_events`);
    const other = (r.rows[0] as { id: number }).id;
    currentStaff = staff({ username: 'a-admin', partnerId: 'A' });
    await expect(reviewAmlAlertAction(form({ alertId: String(other), disposition: 'no_action' }))).rejects.toThrow('Alert not found');
  });

  it('malformed ids and dispositions are refused', async () => {
    for (const alertId of ['', 'abc', '1.5', '-1', '99999999999999999999']) {
      await expect(reviewAmlAlertAction(form({ alertId, disposition: 'no_action' })), alertId).rejects.toThrow('Alert not found');
    }
    await expect(reviewAmlAlertAction(form({ alertId: String(alertA), disposition: 'delete' }))).rejects.toThrow('Invalid disposition');
    expect(await rows('aml.reviewed')).toEqual([]);
  });

  it("own-tenant review writes one aml.reviewed row under the ALERT's tenant, with a bounded note", async () => {
    currentStaff = staff({ username: 'a-agent', role: 'agent', partnerId: 'A' });
    await reviewAmlAlertAction(form({ alertId: String(alertA), disposition: 'escalated', note: 'x'.repeat(900) }));
    const r = await rows('aml.reviewed');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ partner_id: 'A', actor: 'a-agent', actor_type: 'staff', subject_id: 'tr_a' });
    expect(r[0].meta).toMatchObject({ alertId: alertA, disposition: 'escalated' });
    expect(String(r[0].meta.note).length).toBeLessThanOrEqual(500);
  });

  it('platform staff may review any tenant; a second review of the same alert writes nothing', async () => {
    await reviewAmlAlertAction(form({ alertId: String(alertB), disposition: 'no_action' }));
    await reviewAmlAlertAction(form({ alertId: String(alertB), disposition: 'escalated' }));
    const r = await rows('aml.reviewed');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ partner_id: 'B', subject_id: 'tr_b' });
  });
});

describe('audit case queries (compliance-09 partial)', () => {
  it('getById(null) is unfiltered; getById(partner) is pinned', async () => {
    const repo = createAuditRepo(db);
    expect((await repo.getById(null, alertB))?.partnerId).toBe('B');
    expect(await repo.getById('A', alertB)).toBeNull();
    expect((await repo.getById('B', alertB))?.action).toBe('aml.alert');
  });

  it('listOpenAmlAlerts drops reviewed alerts and is tenant-pinned', async () => {
    const repo = createAuditRepo(db);
    expect((await repo.listOpenAmlAlerts(null, 50)).map((r) => r.id).sort()).toEqual([alertA, alertB].sort());
    expect((await repo.listOpenAmlAlerts('A', 50)).map((r) => r.id)).toEqual([alertA]);
    await reviewAmlAlertAction(form({ alertId: String(alertA), disposition: 'no_action' }));
    expect((await repo.listOpenAmlAlerts(null, 50)).map((r) => r.id)).toEqual([alertB]);
  });

  it('listBySubject and listByAction are tenant-keyed and date-bounded', async () => {
    const repo = createAuditRepo(db);
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);
    expect((await repo.listBySubject('A', 'tr_a', from, to)).map((r) => r.action)).toEqual(['aml.alert']);
    expect(await repo.listBySubject('B', 'tr_a', from, to)).toEqual([]);
    expect(await repo.listBySubject('A', 'tr_a', to, new Date(Date.now() + 120_000))).toEqual([]);
    expect((await repo.listByAction('aml.alert', { from, to, limit: 10 })).length).toBe(2);
    expect((await repo.listByAction('aml.alert', { partnerId: 'B', from, to, limit: 10 })).map((r) => r.subjectId)).toEqual(['tr_b']);
  });
});
