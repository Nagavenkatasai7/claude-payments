import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Schedule, ScheduleStatus } from '@/lib/types';

// Merge plan 2a: scheduleOpAction (pause / resume / cancel from /partner/schedules). Admin only
// (D1); the schedule resolves inside the session tenant; a typed reason; the transition table; the
// shared staff writer (conditional status write + audit row in ONE transaction).
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
const revalidated: string[] = [];
let failAudit = false;
// Runs once, right after the action's tenant-scoped read returns (a concurrent change lands here).
const afterRead: { fn: null | (() => Promise<unknown>) } = { fn: null };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
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
vi.mock('@/db/repos/partner-schedule-reads', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-schedule-reads')>();
  return {
    ...real,
    getPartnerSchedule: async (...a: Parameters<typeof real.getPartnerSchedule>) => {
      const r = await real.getPartnerSchedule(...a);
      const fn = afterRead.fn;
      afterRead.fn = null;
      if (fn) await fn();
      return r;
    },
  };
});

import { scheduleOpAction } from '@/app/partner/(app)/schedules/actions';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { t } from '@/lib/i18n';
import { STAFF_REASON_MIN } from '@/lib/send-limits';

const REASON = 'Customer asked us to pause this month.';
const DEST = 'ACCT 000111222333 IFSC HDFC0001';
const form = (id: string, op = 'pause', reason = REASON) => {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('op', op);
  fd.set('reason', reason);
  return fd;
};
function schedule(id: string, partnerId: string, status: ScheduleStatus = 'active'): Schedule {
  return {
    id, phone: '15550007777', amountUsd: 90, recipientName: 'Firstname Lastname', recipientPhone: '919800003333',
    payoutMethod: 'bank', payoutDestination: DEST, fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 4,
    status, createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId, sourceCurrency: 'USD', amountSource: 90,
  };
}
const rows = async <T,>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;
const statusOf = async (id: string) => (await rows<{ status: string }>(sql`SELECT status FROM schedules WHERE id = ${id}`))[0]?.status;
const audits = () => rows<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
const snapshot = async () => ({ a: await statusOf('sa1'), b: await statusOf('sb1'), audit: (await audits()).length });
const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  failAudit = false;
  afterRead.fn = null;
  db = await freshDb();
  await seedTwoTenants(db);
  await createScheduleRepo(db).saveSchedule(schedule('sa1', 'pa'));
  await createScheduleRepo(db).saveSchedule(schedule('sb1', 'pb'));
});

describe('scheduleOpAction: the shared action contract', () => {
  it('runs checklist items 1-4 for pause (an agent is the disallowed role: D1)', async () => {
    await expectPartnerActionContract({ db, redis, cookieJar, action: scheduleOpAction, form: (id) => form(id), ownId: 'sa1', foreignId: 'sb1', allowedRole: 'admin', disallowedRole: 'agent', snapshot });
    expect(await statusOf('sa1')).toBe('paused');
    expect(await statusOf('sb1')).toBe('active');
  });
  it('finance and support are refused too, nothing written', async () => {
    for (const role of ['finance', 'support'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(scheduleOpAction(form('sa1'))).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toEqual({ a: 'active', b: 'active', audit: 0 });
  });
});

describe('scheduleOpAction: transitions and the audit row', () => {
  it('pause writes ONE schedule.pause row with states, reason and actorScope; no destination or phone', async () => {
    await asAdmin();
    expect(await scheduleOpAction(form('sa1'))).toEqual({ ok: true });
    expect(await statusOf('sa1')).toBe('paused');
    const [row, ...rest] = await audits();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ partner_id: 'pa', actor: 'pa-admin', actor_type: 'staff', action: 'schedule.pause', subject_id: 'sa1', meta: { from: 'active', to: 'paused', reason: REASON, actorScope: 'partner' } });
    const json = JSON.stringify(row);
    for (const pii of ['000111222333', '15550007777', 'Lastname']) expect(json).not.toContain(pii);
    expect(revalidated).toContain('/partner/schedules');
  });
  it('resume and cancel follow the transition table', async () => {
    await asAdmin();
    await scheduleOpAction(form('sa1', 'pause'));
    expect(await scheduleOpAction(form('sa1', 'resume'))).toEqual({ ok: true });
    expect(await statusOf('sa1')).toBe('active');
    expect(await scheduleOpAction(form('sa1', 'cancel'))).toEqual({ ok: true });
    expect(await statusOf('sa1')).toBe('cancelled');
    expect((await audits()).map((r) => [r.action, r.meta.from, r.meta.to])).toEqual([
      ['schedule.pause', 'active', 'paused'],
      ['schedule.resume', 'paused', 'active'],
      ['schedule.cancel', 'active', 'cancelled'],
    ]);
  });
  it('wrong state: resume on active, pause on paused, anything on cancelled → not allowed, nothing written', async () => {
    await asAdmin();
    const notAllowed = { ok: false, error: t('partner.schedules.notAllowed') };
    expect(await scheduleOpAction(form('sa1', 'resume'))).toEqual(notAllowed);
    await scheduleOpAction(form('sa1', 'pause'));
    expect(await scheduleOpAction(form('sa1', 'pause'))).toEqual(notAllowed);
    await scheduleOpAction(form('sa1', 'cancel'));
    for (const op of ['pause', 'resume', 'cancel']) expect(await scheduleOpAction(form('sa1', op))).toEqual(notAllowed);
    expect(await statusOf('sa1')).toBe('cancelled');
    expect((await audits()).map((r) => r.action)).toEqual(['schedule.pause', 'schedule.cancel']);
  });
  it('an op outside the closed set is refused before any read or write', async () => {
    await asAdmin();
    for (const op of ['delete', 'activate', 'PAUSE', '']) expect(await scheduleOpAction(form('sa1', op))).toEqual({ ok: false, error: t('partner.schedules.notAllowed') });
    expect(await snapshot()).toEqual({ a: 'active', b: 'active', audit: 0 });
  });
  it('a missing, malformed or foreign id is the same not-found', async () => {
    await asAdmin();
    const notFound = { ok: false, error: t('partner.schedules.notFound') };
    for (const id of ['nope', '', 'a b', 'sb1']) expect(await scheduleOpAction(form(id))).toEqual(notFound);
    expect(await snapshot()).toEqual({ a: 'active', b: 'active', audit: 0 });
  });
});

describe('scheduleOpAction: the reason', () => {
  it(`is required (at least ${STAFF_REASON_MIN} characters) and may not carry a phone/account-length number`, async () => {
    await asAdmin();
    expect(await scheduleOpAction(form('sa1', 'pause', 'too short'))).toEqual({ ok: false, error: t('partner.schedules.reasonTooShort', { min: STAFF_REASON_MIN }) });
    expect(await scheduleOpAction(form('sa1', 'pause', '          '))).toMatchObject({ ok: false });
    const fd = form('sa1');
    fd.delete('reason');
    expect(await scheduleOpAction(fd)).toMatchObject({ ok: false });
    expect(await scheduleOpAction(form('sa1', 'pause', 'Customer 415 555 0101 called'))).toEqual({ ok: false, error: t('partner.schedules.reasonHasNumber') });
    expect(await snapshot()).toEqual({ a: 'active', b: 'active', audit: 0 });
  });
});

describe('scheduleOpAction: atomicity', () => {
  it('a lost race (the row changed after the read) writes nothing and says so', async () => {
    await asAdmin();
    afterRead.fn = () => createScheduleRepo(db).setStatusIf('sa1', 'pa', ['active'], 'cancelled');
    expect(await scheduleOpAction(form('sa1', 'pause'))).toEqual({ ok: false, error: t('partner.schedules.changed') });
    expect(await statusOf('sa1')).toBe('cancelled');
    expect(await audits()).toEqual([]);
  });
  it('a failed audit insert rolls the status write back and returns the fixed failure copy', async () => {
    await asAdmin();
    failAudit = true;
    const r = await scheduleOpAction(form('sa1', 'pause'));
    expect(r).toEqual({ ok: false, error: t('partner.common.failed') });
    expect(JSON.stringify(r)).not.toContain('audit insert failed');
    failAudit = false;
    expect(await statusOf('sa1')).toBe('active');
    expect(await audits()).toEqual([]);
  });
});
