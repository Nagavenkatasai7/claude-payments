import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 3 T9 (R27, contract 12): signPostureAction on /partner/onboarding. Order: the site-host
// guard, PARTNER_ADMIN, the actor's own staff MFA (before the step-up), the input parse, the
// 'posture.sign' step-up, then ONE transaction (writePosture), a poke and a revalidate. The tenant
// is the SESSION's: a forged partnerId / partner field is never read.

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
import { STEP_UP_FIELD, isStepUpRequired } from '@/lib/staff-step-up-result';
import { signPostureAction } from '@/app/partner/(app)/onboarding/actions';

const VALID = { kycDecider: 'smartremit_procedures', holdDecider: 'partner', fourEyesNonSanctions: 'on' };
const form = (o: Record<string, string> = VALID) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
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
const postureOf = async (id: string) => (await rows<{ p: unknown }>(sql`SELECT live_controls -> 'posture' AS p FROM partners WHERE id = ${id}`))[0].p;
const admin = (o: Partial<Staff> = {}) => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin', ...o });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  pokeSpy.mockClear();
  staffMfa.enrolled = new Set(['pa-admin']);
  gate.bypass = true;
  gate.calls = [];
  db = await freshDb();
  await seedTwoTenants(db);
});

describe('signPostureAction', () => {
  it('a site host is refused (404) before the gate, nothing written', async () => {
    await admin();
    host = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(signPostureAction(null, form())).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toBe(before);
  });

  it('anonymous, platform, agent, support, finance -> redirected; nothing written', async () => {
    const before = await snapshot();
    await expect(signPostureAction(null, form())).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined, role: 'admin' });
    await expect(signPostureAction(null, form())).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      staffMfa.enrolled.add(`pa-${role}`);
      await expect(signPostureAction(null, form())).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it('an admin without MFA -> the needMfa copy, nothing written, no step-up asked', async () => {
    staffMfa.enrolled = new Set();
    await admin();
    const before = await snapshot();
    expect(await signPostureAction(null, form())).toEqual({ ok: false, error: t('partner.live.posture.needMfa') });
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it('a missing or unknown kycDecider / holdDecider -> the invalid copy before the step-up', async () => {
    await admin();
    const before = await snapshot();
    const bad: Record<string, string>[] = [
      { holdDecider: 'partner' },
      { kycDecider: 'smartremit_procedures' },
      { kycDecider: 'nobody', holdDecider: 'partner' },
      { kycDecider: 'smartremit_procedures', holdDecider: 'smartremit' },
    ];
    for (const f of bad) {
      expect(await signPostureAction(null, form(f))).toEqual({ ok: false, error: t('partner.live.posture.invalid') });
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it('a stale session -> step_up_required, nothing written; the retry with the code signs, ok, one poke', async () => {
    gate.bypass = false;
    await admin();
    const before = await snapshot();
    const r = await signPostureAction(null, form());
    expect(isStepUpRequired(r)).toBe(true);
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();

    const retry = form();
    retry.set(STEP_UP_FIELD, staffMfa.code);
    expect(await signPostureAction(null, retry)).toEqual({ ok: true });
    expect(gate.calls).toEqual(['posture.sign', 'posture.sign']);
    expect(await postureOf('pa')).toMatchObject({ signedBy: 'pa-admin', kycDecider: 'smartremit_procedures', holdDecider: 'partner', fourEyesNonSanctions: true, requireKycBeforeSend: true });
    expect(pokeSpy).toHaveBeenCalledTimes(1);
  });

  it("forged partnerId / partner fields are ignored: pa's admin signs pa only", async () => {
    await admin();
    const f = form({ ...VALID, fourEyesNonSanctions: '' });
    f.set('partnerId', 'pb');
    f.set('partner', 'pb');
    expect(await signPostureAction(null, f)).toEqual({ ok: true });
    expect(await postureOf('pa')).toMatchObject({ fourEyesNonSanctions: false });
    expect(await postureOf('pb')).toBeNull();
    const audit = await rows<{ partner_id: string; subject_id: string }>(sql`SELECT partner_id, subject_id FROM audit_events WHERE action = 'partner.live.posture.sign'`);
    expect(audit).toEqual([{ partner_id: 'pa', subject_id: 'pa' }]);
  });

  it('a mismatch with the platform kycMode -> the mismatch copy, nothing written, no poke', async () => {
    await admin();
    const before = await snapshot();
    expect(await signPostureAction(null, form({ ...VALID, kycDecider: 'partner' }))).toEqual({ ok: false, error: t('partner.live.posture.mismatch') });
    expect(await snapshot()).toBe(before);
    expect(pokeSpy).not.toHaveBeenCalled();
  });
});
