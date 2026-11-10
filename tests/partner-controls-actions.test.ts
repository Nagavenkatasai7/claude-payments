import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import { certifyPartnerForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 3 T11 (R26, R13; contract 12): the two /partner/controls actions. Order: the site-host
// guard, PARTNER_ADMIN, the actor's own staff MFA (before any step-up), the input parse, the
// step-up ONLY on a resume ('switch.resume') or an approval ('optin.approve'), then the write, a
// poke and a revalidate. Making things safer (a pause, a withdrawal) never needs a re-auth. The
// tenant is the SESSION's: a forged partnerId / scopeId / partner field is never read.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
let host = 'smartremit.ai';
const staffMfa = vi.hoisted(() => ({ enrolled: new Set<string>(), code: '123456' }));
const gate = vi.hoisted(() => ({ bypass: false, calls: [] as string[] }));
const writer = vi.hoisted(() => ({ throws: false }));
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
const revalidate = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath: revalidate }));
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
vi.mock('@/lib/flag-switch', async (orig) => {
  const actual = await orig<typeof import('@/lib/flag-switch')>();
  return {
    ...actual,
    applyPartnerFlagChange: async (...a: Parameters<typeof actual.applyPartnerFlagChange>) => {
      if (writer.throws) throw new Error('db down');
      return actual.applyPartnerFlagChange(...a);
    },
  };
});
const pokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/outbox', async (orig) => ({ ...(await orig<typeof import('@/lib/outbox')>()), pokeWorker: pokeSpy }));

import { t } from '@/lib/i18n';
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { invalidateFlagCache, readFlag } from '@/lib/flags';
import { capabilityOpen } from '@/lib/live-gate';
import { writeOptIn } from '@/lib/live-controls-write';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { setPartnerSwitchAction, approveCapabilityAction } from '@/app/partner/(app)/controls/actions';

const REASON = 'Pausing while we check a rail issue';
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const pause = (o: Record<string, string> = {}) => form({ key: 'sends.paused', enabled: 'on', reason: REASON, ...o });
const resume = (o: Record<string, string> = {}) => form({ key: 'sends.paused', enabled: 'off', reason: 'Rail issue fixed, resuming now', ...o });
async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
const snapshot = async () =>
  JSON.stringify({
    flags: await rows(sql`SELECT key, scope_type, scope_id, enabled FROM feature_flags ORDER BY key, scope_id`),
    lc: await rows(sql`SELECT id, live_controls FROM partners ORDER BY id`),
    audit: await rows(sql`SELECT id, action, partner_id FROM audit_events WHERE action <> 'auth.stepup' ORDER BY id`),
    outbox: await rows(sql`SELECT id FROM outbox ORDER BY id`),
  });
const flagRows = () => rows<{ scope_id: string; enabled: boolean; updated_by: string }>(sql`SELECT scope_id, enabled, updated_by FROM feature_flags ORDER BY scope_id`);
const admin = (o: Partial<Staff> = {}) => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin', ...o });
const switchCall = (fd: FormData) => setPartnerSwitchAction(null, fd);
const approveCall = (fd: FormData) => approveCapabilityAction(null, fd);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  pokeSpy.mockClear();
  revalidate.mockClear();
  staffMfa.enrolled = new Set(['pa-admin', 'contract-allowed']);
  gate.bypass = false;
  gate.calls = [];
  writer.throws = false;
  db = await freshDb();
  invalidateFlagCache(db);
  await seedTwoTenants(db);
});

describe('setPartnerSwitchAction', () => {
  it('a site host is refused (404) before the gate, nothing written (both actions)', async () => {
    await admin();
    host = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(setPartnerSwitchAction(null, pause())).rejects.toThrow('NOT_FOUND');
    await expect(approveCapabilityAction(null, form({ capability: 'b2b', on: 'off' }))).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });

  it('anonymous, platform, agent, support, finance -> redirected, nothing written (both actions)', async () => {
    gate.bypass = true;
    for (const disallowedRole of ['agent', 'support', 'finance'] as const) {
      await expectPartnerActionContract({
        db,
        redis,
        cookieJar,
        action: switchCall,
        form: () => pause(),
        ownId: 'pa',
        foreignId: 'pb',
        allowedRole: 'admin',
        disallowedRole,
        snapshot,
        tenantOnly: { foreignSnapshot: () => rows(sql`SELECT * FROM feature_flags WHERE scope_id LIKE 'tenant:pb%'`) },
      });
      await expectPartnerActionContract({
        db,
        redis,
        cookieJar,
        action: approveCall,
        form: () => form({ capability: 'b2b', on: 'off' }),
        ownId: 'pa',
        foreignId: 'pb',
        allowedRole: 'admin',
        disallowedRole,
        snapshot,
        tenantOnly: { foreignSnapshot: () => rows(sql`SELECT live_controls FROM partners WHERE id = 'pb'`) },
      });
    }
    expect((await flagRows()).map((r) => r.scope_id)).toEqual(['tenant:pa']);
  });

  it('no MFA -> partner.controls.needMfa; gatePartnerStepUp never called; nothing written (both actions)', async () => {
    staffMfa.enrolled = new Set();
    await admin();
    const before = await snapshot();
    expect(await setPartnerSwitchAction(null, pause())).toEqual({ ok: false, error: t('partner.controls.needMfa') });
    expect(await setPartnerSwitchAction(null, resume())).toEqual({ ok: false, error: t('partner.controls.needMfa') });
    expect(await approveCapabilityAction(null, form({ capability: 'b2b', on: 'on' }))).toEqual({ ok: false, error: t('partner.controls.needMfa') });
    expect(await approveCapabilityAction(null, form({ capability: 'b2b', on: 'off' }))).toEqual({ ok: false, error: t('partner.controls.needMfa') });
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it('pause sends, stale session -> ok with no step-up: row tenant:pa; readFlag on for pa, off for pb; one poke', async () => {
    await admin();
    expect(await setPartnerSwitchAction(null, pause())).toEqual({ ok: true });
    expect(gate.calls).toEqual([]);
    expect(await flagRows()).toEqual([{ scope_id: 'tenant:pa', enabled: true, updated_by: 'pa-admin' }]);
    expect(await readFlag(db, 'sends.paused', { partnerId: 'pa' })).toBe('on');
    expect(await readFlag(db, 'sends.paused', { partnerId: 'pb' })).toBe('off');
    expect(pokeSpy).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith('/partner', 'layout');
  });

  it('resume, stale -> step_up_required, nothing written; retry with code -> off, flag.change audit previous true', async () => {
    await admin();
    expect(await setPartnerSwitchAction(null, pause())).toEqual({ ok: true });
    pokeSpy.mockClear();
    const before = await snapshot();
    const r = await setPartnerSwitchAction(null, resume());
    expect(isStepUpRequired(r)).toBe(true);
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();

    const retry = resume();
    retry.set(STEP_UP_FIELD, staffMfa.code);
    expect(await setPartnerSwitchAction(null, retry)).toEqual({ ok: true });
    expect(gate.calls).toEqual(['switch.resume', 'switch.resume']);
    expect(await flagRows()).toEqual([{ scope_id: 'tenant:pa', enabled: false, updated_by: 'pa-admin' }]);
    invalidateFlagCache(db);
    expect(await readFlag(db, 'sends.paused', { partnerId: 'pa' })).toBe('off');
    const audit = await rows<{ meta: Record<string, unknown> }>(sql`SELECT meta FROM audit_events WHERE action = 'flag.change' ORDER BY id`);
    expect(audit).toHaveLength(2);
    expect(audit[1].meta).toMatchObject({ key: 'sends.paused', scopeId: 'tenant:pa', enabled: false, previous: true, actorScope: 'partner' });
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });

  it("corridor 'in' on sends -> tenant:pa:IN; a corridor on agent.paused -> badCorridor before the step-up", async () => {
    await admin();
    expect(await setPartnerSwitchAction(null, pause({ corridor: 'in' }))).toEqual({ ok: true });
    expect(await flagRows()).toEqual([{ scope_id: 'tenant:pa:IN', enabled: true, updated_by: 'pa-admin' }]);
    expect(await readFlag(db, 'sends.paused', { partnerId: 'pa', corridor: 'IN' })).toBe('on');
    expect(await readFlag(db, 'sends.paused', { partnerId: 'pa', corridor: 'MX' })).toBe('off');
    const before = await snapshot();
    for (const enabled of ['on', 'off']) {
      expect(await setPartnerSwitchAction(null, form({ key: 'agent.paused', enabled, corridor: 'IN', reason: REASON }))).toEqual({ ok: false, error: t('partner.controls.badCorridor') });
      expect(await setPartnerSwitchAction(null, form({ key: 'sends.paused', enabled, corridor: 'PH', reason: REASON }))).toEqual({ ok: false, error: t('partner.controls.badCorridor') });
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it("unknown key, '__proto__', voice.notes, a bad enabled -> invalid; a reason under 10 characters -> the reason copy; all before the step-up and any write", async () => {
    await admin();
    const before = await snapshot();
    for (const key of ['nope.key', '__proto__', 'voice.notes', 'constructor', '']) {
      for (const enabled of ['on', 'off']) {
        expect(await setPartnerSwitchAction(null, form({ key, enabled, reason: REASON })), key).toEqual({ ok: false, error: t('partner.controls.invalid') });
      }
    }
    expect(await setPartnerSwitchAction(null, form({ key: 'sends.paused', enabled: 'true', reason: REASON }))).toEqual({ ok: false, error: t('partner.controls.invalid') });
    expect(await setPartnerSwitchAction(null, form({ key: 'sends.paused', reason: REASON }))).toEqual({ ok: false, error: t('partner.controls.invalid') });
    for (const enabled of ['on', 'off']) {
      expect(await setPartnerSwitchAction(null, form({ key: 'sends.paused', enabled, reason: 'too short' }))).toEqual({ ok: false, error: t('partner.controls.reason') });
      expect(await setPartnerSwitchAction(null, form({ key: 'sends.paused', enabled }))).toEqual({ ok: false, error: t('partner.controls.reason') });
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
    expect(pokeSpy).not.toHaveBeenCalled();
  });

  it("forged partnerId / scopeId / partner fields are ignored: pa's admin writes tenant:pa only", async () => {
    await admin();
    const f = pause();
    f.set('partnerId', 'pb');
    f.set('scopeId', 'tenant:pb');
    f.set('scopeType', 'global');
    f.set('partner', 'pb');
    expect(await setPartnerSwitchAction(null, f)).toEqual({ ok: true });
    expect(await flagRows()).toEqual([{ scope_id: 'tenant:pa', enabled: true, updated_by: 'pa-admin' }]);
    const audit = await rows<{ partner_id: string }>(sql`SELECT partner_id FROM audit_events WHERE action = 'flag.change'`);
    expect(audit).toEqual([{ partner_id: 'pa' }]);
  });

  it('a writer throw -> partner.controls.failed, no poke', async () => {
    await admin();
    writer.throws = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await setPartnerSwitchAction(null, pause())).toEqual({ ok: false, error: t('partner.controls.failed') });
    } finally {
      warn.mockRestore();
    }
    expect(pokeSpy).not.toHaveBeenCalled();
  });
});

describe('approveCapabilityAction', () => {
  const partner = async () => createPartnerRepo(db).getPartner('pa');
  const recordCounsel = (cap: 'b2b' | 'usdc') =>
    db.transaction((tx) => writeOptIn(tx, 'pa', { username: 'owner-admin', scope: 'platform' }, cap, { kind: 'counsel', counselRef: 'COUNSEL-REF-1' }));

  it('uncertified -> optin.notCertified; certified without counsel -> optin.noCounsel; counsel + stale -> step_up_required; with the code -> approved, one audit, one poke', async () => {
    gate.bypass = true;
    await admin();
    const before = await snapshot();
    expect(await approveCapabilityAction(null, form({ capability: 'b2b', on: 'on' }))).toEqual({ ok: false, error: t('partner.controls.optin.notCertified') });
    await certifyPartnerForTest(db, 'pa', { optIns: [] });
    const certified = await snapshot();
    expect(certified).not.toBe(before);
    expect(await approveCapabilityAction(null, form({ capability: 'b2b', on: 'on' }))).toEqual({ ok: false, error: t('partner.controls.optin.noCounsel') });
    expect(await snapshot()).toBe(certified);
    expect(pokeSpy).not.toHaveBeenCalled();

    await recordCounsel('b2b');
    gate.bypass = false;
    gate.calls = [];
    const counselled = await snapshot();
    const r = await approveCapabilityAction(null, form({ capability: 'b2b', on: 'on' }));
    expect(isStepUpRequired(r)).toBe(true);
    expect(await snapshot()).toBe(counselled);
    expect(capabilityOpen(await partner(), 'b2b')).toBe(false);

    const retry = form({ capability: 'b2b', on: 'on' });
    retry.set(STEP_UP_FIELD, staffMfa.code);
    expect(await approveCapabilityAction(null, retry)).toEqual({ ok: true });
    expect(gate.calls).toEqual(['optin.approve', 'optin.approve']);
    expect(capabilityOpen(await partner(), 'b2b')).toBe(true);
    expect((await partner())?.liveControls?.optIns.b2b).toMatchObject({ partnerApprovedBy: 'pa-admin' });
    const audit = await rows<{ partner_id: string; actor: string; meta: Record<string, unknown> }>(sql`SELECT partner_id, actor, meta FROM audit_events WHERE action = 'partner.live.optin.approve'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ partner_id: 'pa', actor: 'pa-admin', meta: { capability: 'b2b', on: true } });
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });

  it('withdraw needs no step-up; partnerApproved* gone; capabilityOpen false', async () => {
    await certifyPartnerForTest(db, 'pa'); // every capability counselled and approved
    await admin();
    expect(capabilityOpen(await partner(), 'usdc')).toBe(true);
    expect(await approveCapabilityAction(null, form({ capability: 'usdc', on: 'off' }))).toEqual({ ok: true });
    expect(gate.calls).toEqual([]);
    const usdc = (await partner())?.liveControls?.optIns.usdc;
    expect(usdc?.partnerApprovedAt).toBeUndefined();
    expect(usdc?.partnerApprovedBy).toBeUndefined();
    expect(usdc?.counselRef).toBeDefined();
    expect(capabilityOpen(await partner(), 'usdc')).toBe(false);
    expect(capabilityOpen(await partner(), 'b2b')).toBe(true);
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });

  it('an unknown capability or a bad on -> invalid, before the step-up and any write', async () => {
    await certifyPartnerForTest(db, 'pa');
    await admin();
    const before = await snapshot();
    for (const capability of ['nope', '__proto__', 'routing', '']) {
      for (const on of ['on', 'off']) {
        expect(await approveCapabilityAction(null, form({ capability, on })), capability).toEqual({ ok: false, error: t('partner.controls.invalid') });
      }
    }
    expect(await approveCapabilityAction(null, form({ capability: 'b2b', on: 'yes' }))).toEqual({ ok: false, error: t('partner.controls.invalid') });
    expect(await approveCapabilityAction(null, form({ capability: 'b2b' }))).toEqual({ ok: false, error: t('partner.controls.invalid') });
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it('a forged partnerId never approves for another tenant', async () => {
    await certifyPartnerForTest(db, 'pb');
    await admin();
    const f = form({ capability: 'b2b', on: 'off' });
    f.set('partnerId', 'pb');
    expect(await approveCapabilityAction(null, f)).toEqual({ ok: true });
    expect((await createPartnerRepo(db).getPartner('pb'))?.liveControls?.optIns.b2b?.partnerApprovedAt).toBeDefined();
  });
});
