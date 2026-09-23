import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createScheduleStore } from '@/lib/schedule-store';
import type { Staff, Schedule } from '@/lib/types';

// Program-Fix 36 (schedules-02): pause / resume / cancel are PUBLIC POST
// endpoints. Each self-gates (requireStaff + canCancel), loads the schedule by
// the form id, checks partner scope BEFORE any write (404-never-403), decides
// the transition, writes it CONDITIONALLY, and records ONE audit_events row in
// the same transaction.

let currentStaff: Staff;
let db: Awaited<ReturnType<typeof freshDb>>;
let scheduleStore: ReturnType<typeof createScheduleStore>;
let failAudit = false;

vi.mock('@/lib/auth', () => ({
  requireStaff: async () => currentStaff,
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/schedule-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/schedule-store')>('@/lib/schedule-store');
  return { ...actual, getScheduleStore: () => scheduleStore };
});
// The audit repo is the real one, with a switch to force its insert to fail:
// a failed audit insert must roll the status write back (same bar as fix 16b).
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (dbx: Parameters<typeof real.createAuditRepo>[0]) => {
      const r = real.createAuditRepo(dbx);
      return {
        ...r,
        record: async (e: Parameters<typeof r.record>[0]) => {
          if (failAudit) throw new Error('audit insert failed');
          return r.record(e);
        },
      };
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  pauseScheduleAction,
  resumeScheduleAction,
  cancelScheduleAction,
} from '@/app/admin-dashboard/schedules/actions';

function staff(overrides: Partial<Staff>): Staff {
  return {
    username: 'u', name: 'U', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function schedule(id: string, partnerId: string, status: Schedule['status'] = 'active'): Schedule {
  return {
    id, phone: '15551234567', amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'bank', payoutDestination: 'ACCT 000111222333 IFSC HDFC0001', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 2, status,
    createdAt: '2026-05-21T00:00:00.000Z',
    partnerId,
    sourceCurrency: 'USD',
    amountSource: 200,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function auditRows() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
}

async function statusOf(id: string) {
  return (await scheduleStore.getSchedule(id))?.status;
}

beforeEach(async () => {
  failAudit = false;
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  scheduleStore = createScheduleStore(db);
  await scheduleStore.saveSchedule(schedule('sa', 'A'));
  await scheduleStore.saveSchedule(schedule('sb', 'B'));
  currentStaff = staff({ username: 'root' }); // platform admin
});

describe('schedule actions — gate (test 3)', () => {
  it("partner-A staff pausing a partner-B schedule gets 'Schedule not found' (never 403); nothing changes", async () => {
    currentStaff = staff({ username: 'a-admin', partnerId: 'A' });
    await expect(pauseScheduleAction(form({ id: 'sb' }))).rejects.toThrow('Schedule not found');
    expect(await statusOf('sb')).toBe('active');
    expect(await auditRows()).toEqual([]);
  });

  it('a support-role agent (no money permissions) is refused before any read', async () => {
    currentStaff = staff({
      username: 'sup', role: 'support',
      permissions: { canCancel: false, canResend: false, canAssign: false },
    });
    await expect(pauseScheduleAction(form({ id: 'sa' }))).rejects.toThrow('You do not have permission');
    expect(await statusOf('sa')).toBe('active');
    expect(await auditRows()).toEqual([]);
  });

  it('an agent without canCancel is refused; one WITH canCancel (own tenant) may pause', async () => {
    currentStaff = staff({
      username: 'ag', role: 'agent', partnerId: 'A',
      permissions: { canCancel: false, canResend: true, canAssign: true },
    });
    await expect(cancelScheduleAction(form({ id: 'sa' }))).rejects.toThrow('You do not have permission');
    expect(await statusOf('sa')).toBe('active');

    currentStaff = staff({
      username: 'ag2', role: 'agent', partnerId: 'A',
      permissions: { canCancel: true, canResend: false, canAssign: false },
    });
    await pauseScheduleAction(form({ id: 'sa' }));
    expect(await statusOf('sa')).toBe('paused');
  });

  it('an unknown id is "Schedule not found" — the same message as out-of-scope', async () => {
    await expect(pauseScheduleAction(form({ id: 'nope' }))).rejects.toThrow('Schedule not found');
    await expect(pauseScheduleAction(form({}))).rejects.toThrow('Schedule not found');
  });
});

describe('schedule actions — transitions + audit (test 3)', () => {
  it('admin pause: status paused + ONE schedule.pause audit row {from:active,to:paused}; no PII in meta', async () => {
    await pauseScheduleAction(form({ id: 'sa', reason: '  customer asked  ' }));
    expect(await statusOf('sa')).toBe('paused');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'A', actor: 'root', actor_type: 'staff', action: 'schedule.pause', subject_id: 'sa',
      meta: { from: 'active', to: 'paused', reason: 'customer asked' },
    });
    expect(JSON.stringify(rows[0].meta)).not.toContain('000111222333');
  });

  it('resume: paused → active with a schedule.resume row; reason omitted when blank', async () => {
    await pauseScheduleAction(form({ id: 'sa' }));
    await resumeScheduleAction(form({ id: 'sa', reason: '   ' }));
    expect(await statusOf('sa')).toBe('active');
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['schedule.pause', 'schedule.resume']);
    expect(rows[1].meta).toEqual({ from: 'paused', to: 'active' });
  });

  it('cancel from active and from paused both write schedule.cancel with the true from-state', async () => {
    await cancelScheduleAction(form({ id: 'sa' }));
    expect(await statusOf('sa')).toBe('cancelled');
    await pauseScheduleAction(form({ id: 'sb' }));
    await cancelScheduleAction(form({ id: 'sb' }));
    expect(await statusOf('sb')).toBe('cancelled');
    const cancels = (await auditRows()).filter((r) => r.action === 'schedule.cancel');
    expect(cancels.map((r) => r.meta)).toEqual([
      { from: 'active', to: 'cancelled' },
      { from: 'paused', to: 'cancelled' },
    ]);
  });

  it('cancelled is terminal: resume after cancel is refused, no write, no extra audit row', async () => {
    await cancelScheduleAction(form({ id: 'sa' }));
    await expect(resumeScheduleAction(form({ id: 'sa' }))).rejects.toThrow(/cancelled/);
    await expect(pauseScheduleAction(form({ id: 'sa' }))).rejects.toThrow(/cancelled/);
    expect(await statusOf('sa')).toBe('cancelled');
    expect(await auditRows()).toHaveLength(1);
  });

  it('pause on paused / resume on active are refused with no audit row', async () => {
    await expect(resumeScheduleAction(form({ id: 'sa' }))).rejects.toThrow(/paused/);
    await pauseScheduleAction(form({ id: 'sa' }));
    await expect(pauseScheduleAction(form({ id: 'sa' }))).rejects.toThrow(/already paused/);
    expect(await auditRows()).toHaveLength(1);
  });

  it('the reason is trimmed and capped at 200 characters', async () => {
    await pauseScheduleAction(form({ id: 'sa', reason: 'x'.repeat(500) }));
    const [row] = await auditRows();
    expect((row.meta.reason as string).length).toBe(200);
  });

  it('a failed audit insert rolls the status write back (one transaction)', async () => {
    failAudit = true;
    await expect(pauseScheduleAction(form({ id: 'sa' }))).rejects.toThrow('audit insert failed');
    expect(await statusOf('sa')).toBe('active');
    expect(await auditRows()).toEqual([]);
  });

  it('a lost race (row left the from-state between load and write) throws "changed concurrently" and writes no audit row', async () => {
    // Simulate: the row is cancelled by the customer's bot between the action's
    // load and its conditional write.
    const realGet = scheduleStore.getSchedule.bind(scheduleStore);
    scheduleStore = {
      ...scheduleStore,
      getSchedule: async (id: string) => {
        const s = await realGet(id);
        if (s) await scheduleStore.setStatusIf(id, s.partnerId, ['active'], 'cancelled');
        return s;
      },
    };
    await expect(pauseScheduleAction(form({ id: 'sa' }))).rejects.toThrow(/changed concurrently/);
    expect(await statusOf('sa')).toBe('cancelled');
    expect(await auditRows()).toEqual([]);
  });
});
