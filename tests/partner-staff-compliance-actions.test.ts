import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 3 T9 (R15, contract 12): setComplianceUserAction on /partner/staff. Order: the site-host
// guard, PARTNER_ADMIN, the actor's own staff MFA, the parse and (adding only) the roster check:
// an ACTIVE admin or agent of the SESSION tenant, else "not found" (404-never-403); then the
// 'compliance_user.set' step-up and ONE transaction (writeComplianceUser), a poke, a revalidate.
// Removing needs no roster check: a name that left the team can still be taken off the list.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
let host = 'smartremit.ai';
const staffMfa = vi.hoisted(() => ({ enrolled: new Set<string>(), code: '123456' }));
const gate = vi.hoisted(() => ({ bypass: false, calls: [] as string[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host, 'x-forwarded-for': '203.0.113.7' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
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
vi.mock('@/lib/staff-mfa-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff-mfa-store')>()),
  getStaffMfaStore: () => ({
    isEnrolled: async (u: string) => staffMfa.enrolled.has(u),
    verifyCode: async (_u: string, c: string) => c === staffMfa.code,
  }),
  // The module's own staffMfaEnrolled reads its local getStaffMfaStore, so it is mocked on the same set.
  staffMfaEnrolled: async (u: string) => staffMfa.enrolled.has(u),
}));
vi.mock('@/lib/partner-step-up-gate', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-step-up-gate')>();
  return {
    ...actual,
    gatePartnerStepUp: async (...a: Parameters<typeof actual.gatePartnerStepUp>) => {
      gate.calls.push(a[2]);
      return gate.bypass ? null : actual.gatePartnerStepUp(...a);
    },
  };
});
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));

import { t } from '@/lib/i18n';
import { getAuthStore } from '@/lib/auth-store';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { setComplianceUserAction } from '@/app/partner/(app)/staff/actions';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const form = (username: string, on: string) => {
  const f = new FormData();
  f.set('username', username);
  f.set('on', on);
  return f;
};
async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
const snapshot = async () =>
  JSON.stringify({
    lc: await rows(sql`SELECT id, live_controls FROM partners ORDER BY id`),
    audit: await rows(sql`SELECT id, action, partner_id FROM audit_events WHERE action <> 'auth.stepup' ORDER BY id`),
    outbox: await rows(sql`SELECT id FROM outbox ORDER BY id`),
  });
const listed = async (id = 'pa') => (await rows<{ v: unknown }>(sql`SELECT live_controls -> 'complianceUsers' AS v FROM partners WHERE id = ${id}`))[0].v;
const save = (o: Partial<Staff>) =>
  getAuthStore().saveStaff({ username: 'x', name: 'X', role: 'agent', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), partnerId: 'pa', ...o });
const NOT_FOUND = { ok: false, error: t('partner.staff.notFound') };

beforeEach(async () => {
  redis.dump.clear();
  for (const k of [...redis.sets.keys()]) await redis.del(k);
  cookieJar.clear();
  host = 'smartremit.ai';
  pokeSpy.mockClear();
  staffMfa.enrolled = new Set(['pa-admin']);
  gate.bypass = true;
  gate.calls = [];
  db = await freshDb();
  await seedTwoTenants(db);
  await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
  await save({ username: 'pa-agent', role: 'agent' });
  await save({ username: 'pa-admin2', role: 'admin' });
  await save({ username: 'pa-support', role: 'support' });
  await save({ username: 'pa-fin', role: 'finance' });
  await save({ username: 'pa-gone', role: 'agent', status: 'suspended' });
  await save({ username: 'pb-agent', role: 'agent', partnerId: 'pb' });
  await save({ username: 'plat-admin', role: 'admin', partnerId: undefined });
});

describe('setComplianceUserAction', () => {
  it('adds an active pa agent and admin -> listed; one audit row each, one poke each', async () => {
    expect(await setComplianceUserAction(null, form('pa-agent', 'on'))).toEqual({ ok: true });
    expect(await setComplianceUserAction(null, form('pa-admin2', 'on'))).toEqual({ ok: true });
    expect(await listed()).toEqual(['pa-agent', 'pa-admin2']);
    expect(gate.calls).toEqual(['compliance_user.set', 'compliance_user.set']);
    expect(pokeSpy).toHaveBeenCalledTimes(2);
    const audit = await rows<{ partner_id: string; actor: string; meta: Record<string, unknown> }>(
      sql`SELECT partner_id, actor, meta FROM audit_events WHERE action = 'partner.live.compliance_user.set' ORDER BY id`,
    );
    expect(audit.map((a) => [a.partner_id, a.actor, a.meta.target, a.meta.on])).toEqual([
      ['pa', 'pa-admin', 'pa-agent', true],
      ['pa', 'pa-admin', 'pa-admin2', true],
    ]);
  });

  it("a support or finance target, a suspended target, pb's member, a platform account or an unknown name -> not found, nothing written", async () => {
    const before = await snapshot();
    for (const u of ['pa-support', 'pa-fin', 'pa-gone', 'pb-agent', 'plat-admin', 'pa-nobody']) {
      expect(await setComplianceUserAction(null, form(u, 'on')), u).toEqual(NOT_FOUND);
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it("a bad 'on' value or a malformed username -> not found, nothing written", async () => {
    const before = await snapshot();
    expect(await setComplianceUserAction(null, form('pa-agent', 'yes'))).toEqual(NOT_FOUND);
    expect(await setComplianceUserAction(null, form('', 'off'))).toEqual(NOT_FOUND);
    expect(await setComplianceUserAction(null, form('A B', 'off'))).toEqual(NOT_FOUND);
    expect(await snapshot()).toBe(before);
  });

  it('a full list (20) -> the full copy, nothing written', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `pa-u${i}`);
    await db.execute(sql`UPDATE partners SET live_controls = jsonb_build_object('complianceUsers', ${JSON.stringify(twenty)}::jsonb) WHERE id = 'pa'`);
    const before = await snapshot();
    expect(await setComplianceUserAction(null, form('pa-agent', 'on'))).toEqual({ ok: false, error: t('partner.staff.complianceUser.full') });
    expect(JSON.parse(await snapshot()).audit).toEqual(JSON.parse(before).audit);
    expect(await listed()).toEqual(twenty);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('remove works for a name no longer on the roster', async () => {
    await setComplianceUserAction(null, form('pa-agent', 'on'));
    await getAuthStore().deleteStaff('pa-agent'); // left the team after being listed
    expect(await getAuthStore().getStaff('pa-agent')).toBeNull();
    expect(await setComplianceUserAction(null, form('pa-agent', 'off'))).toEqual({ ok: true });
    expect(await listed()).toEqual([]);
  });

  it("a forged partnerId / partner field is ignored: the session tenant's list changes", async () => {
    const f = form('pa-agent', 'on');
    f.set('partnerId', 'pb');
    f.set('partner', 'pb');
    expect(await setComplianceUserAction(null, f)).toEqual({ ok: true });
    expect(await listed()).toEqual(['pa-agent']);
    expect(await listed('pb')).toBeNull();
  });

  it('no MFA on the actor -> refused before the step-up, nothing written', async () => {
    staffMfa.enrolled = new Set();
    const before = await snapshot();
    expect(await setComplianceUserAction(null, form('pa-agent', 'on'))).toEqual({ ok: false, error: t('partner.staff.complianceUser.needMfa') });
    expect(await setComplianceUserAction(null, form('pa-agent', 'off'))).toEqual({ ok: false, error: t('partner.staff.complianceUser.needMfa') });
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it('a stale session -> step_up_required, nothing written; the retry with the code writes', async () => {
    gate.bypass = false;
    const before = await snapshot();
    expect(isStepUpRequired(await setComplianceUserAction(null, form('pa-agent', 'on')))).toBe(true);
    expect(await snapshot()).toBe(before);
    const retry = form('pa-agent', 'on');
    retry.set(STEP_UP_FIELD, staffMfa.code);
    expect(await setComplianceUserAction(null, retry)).toEqual({ ok: true });
    expect(await listed()).toEqual(['pa-agent']);
  });

  it('a site host is refused; an agent, support or finance session is redirected; nothing written', async () => {
    const before = await snapshot();
    host = 'acme.smartremit.ai';
    await expect(setComplianceUserAction(null, form('pa-agent', 'on'))).rejects.toThrow('NOT_FOUND');
    host = 'smartremit.ai';
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-x-${role}`, partnerId: 'pa', role });
      await expect(setComplianceUserAction(null, form('pa-agent', 'on'))).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toBe(before);
  });
});
