import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';

// B3 rewards v1: the /partner/rewards server action. Partner ADMIN only, own
// tenant only: the target is the session's tenant (ctx.partnerId), a form
// naming partner B changes A only, and the values must sit inside the admin
// catalog's current limits. The partner can never touch the catalog or the
// money terms (fee, give-back, budget).

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value, 'x-forwarded-for': '203.0.113.7' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
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

import { auditEvents, partnerRewardTerms, partnerRewards } from '@/db/schema';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { DEFAULT_CATALOG, DEFAULT_TERMS } from '@/lib/rewards/settings';
import { PARTNER_ROUTES } from '@/app/partner/routes';
import { savePartnerRewardAction } from '@/app/partner/(app)/rewards/actions';

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const rows = () => db.select().from(partnerRewards).orderBy(asc(partnerRewards.partnerId), asc(partnerRewards.kind));
const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));
const strip = (r: Awaited<ReturnType<typeof rows>>) => r.map(({ updatedAt: _u, ...rest }) => rest);
const snapshot = async () => ({ rows: strip(await rows()), audits: (await audits()).length });
const foreignSnapshot = async () => ({ b: strip((await rows()).filter((r) => r.partnerId === 'pb')), bAudits: (await audits()).filter((r) => r.partnerId === 'pb').length });

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  revalidatePath.mockClear();
  db = await freshDb();
  await seedTwoTenants(db);
  const repo = createRewardRepo(db);
  await repo.upsertCatalog({ ...DEFAULT_CATALOG.nth_transfer, available: true }, 'root');
  await repo.upsertCatalog({ ...DEFAULT_CATALOG.festival, available: true, festivalNames: ['Diwali'] }, 'root');
  await repo.upsertPartnerSetting('pb', { kind: 'nth_transfer', enabled: true, nth: 7 }, 'pb-admin');
});

async function signInAdmin(): Promise<void> {
  await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
}

describe('savePartnerRewardAction: the shared /partner action contract', () => {
  it('items 1-4: gate, agent refused, a form naming B acts on A only, forged tenant fields ignored', async () => {
    await expectPartnerActionContract({
      db,
      redis,
      cookieJar,
      action: savePartnerRewardAction,
      form: (id) => {
        const fd = form({ kind: 'nth_transfer', enabled: 'on', nth: id === 'pa' ? '5' : '6' });
        fd.set('id', id);
        fd.set('partnerId', id);
        return fd;
      },
      ownId: 'pa',
      foreignId: 'pb',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot,
      tenantOnly: { foreignSnapshot },
    });
    expect((await createRewardRepo(db).getPartnerSettings('pb')).nth_transfer).toMatchObject({ enabled: true, nth: 7 });
  });

  it('refuses on a partner-site host before anything else', async () => {
    await signInAdmin();
    host.value = 'acme.smartremit.ai';
    const before = await snapshot();
    await expect(savePartnerRewardAction(form({ kind: 'nth_transfer', enabled: 'on', nth: '5' }))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await snapshot()).toEqual(before);
  });

  it('support and finance are refused (→ /partner), with no write', async () => {
    const before = await snapshot();
    for (const role of ['support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(savePartnerRewardAction(form({ kind: 'nth_transfer', enabled: 'on', nth: '5' }))).rejects.toThrow('REDIRECT:/partner');
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('savePartnerRewardAction: the admin limits', () => {
  it('success: one row for A, one audit row with actorScope partner, only /partner/rewards revalidated', async () => {
    await signInAdmin();
    expect(await savePartnerRewardAction(form({ kind: 'nth_transfer', enabled: 'on', nth: '5' }))).toEqual({ ok: true });
    expect((await createRewardRepo(db).getPartnerSettings('pa')).nth_transfer).toMatchObject({ enabled: true, nth: 5 });
    const [a] = await audits();
    expect(a).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', action: 'rewards.partner', subjectId: 'pa:nth_transfer' });
    expect((a.meta as { actorScope?: string }).actorScope).toBe('partner');
    expect(revalidatePath.mock.calls).toEqual([[PARTNER_ROUTES.rewards.href]]);
  });

  it('N outside the catalog range, an unknown kind, or a reward SmartRemit has not made available ⇒ refused, nothing written', async () => {
    await signInAdmin();
    const before = await snapshot();
    for (const bad of <Array<Record<string, string>>>[
      { kind: 'nth_transfer', enabled: 'on', nth: '2' },
      { kind: 'nth_transfer', enabled: 'on', nth: '11' },
      { kind: 'first_transfer', enabled: 'on' },
      { kind: 'cashback', enabled: 'on' },
      { kind: 'festival', enabled: 'on', festivalName: 'Holi', startsOn: '2026-10-01', endsOn: '2026-10-05', minAmountUsd: '0' },
      { kind: 'festival', enabled: 'on', festivalName: 'Diwali', startsOn: '2026-10-01', endsOn: '2026-10-20', minAmountUsd: '0' },
    ]) {
      const r = await savePartnerRewardAction(form(bad));
      expect(r).toMatchObject({ ok: false });
      expect(typeof (r as { error: string }).error).toBe('string');
    }
    await createRewardRepo(db).upsertCatalog({ ...DEFAULT_CATALOG.nth_transfer, available: false }, 'root');
    expect(await savePartnerRewardAction(form({ kind: 'nth_transfer', enabled: 'on', nth: '5' }))).toMatchObject({ ok: false });
    expect(await snapshot()).toEqual(before);
  });

  it('a festival inside the limits saves; turning a reward off always saves', async () => {
    await signInAdmin();
    expect(await savePartnerRewardAction(form({
      kind: 'festival', enabled: 'on', festivalName: 'Diwali', startsOn: '2026-10-20', endsOn: '2026-10-30', minAmountUsd: '100',
    }))).toEqual({ ok: true });
    expect((await createRewardRepo(db).getPartnerSettings('pa')).festival).toMatchObject({
      enabled: true, festivalName: 'Diwali', startsOn: '2026-10-20', endsOn: '2026-10-30', minAmountUsd: 100,
    });
    await createRewardRepo(db).upsertCatalog({ ...DEFAULT_CATALOG.festival, available: false }, 'root');
    expect(await savePartnerRewardAction(form({ kind: 'festival' }))).toEqual({ ok: true });
    expect((await createRewardRepo(db).getPartnerSettings('pa')).festival?.enabled).toBe(false);
  });

  it('the money terms are never read from the form (fee, give-back, budget stay the admin’s)', async () => {
    await signInAdmin();
    await savePartnerRewardAction(form({
      kind: 'nth_transfer', enabled: 'on', nth: '5', platformFeeUsd: '0', giveBackPct: '100', monthlyBudgetUsd: '99999',
    }));
    expect(await db.select().from(partnerRewardTerms)).toEqual([]);
    expect(await createRewardRepo(db).getTerms('pa')).toEqual(DEFAULT_TERMS);
  });
});

it('the route is admin only, in the nav', () => {
  expect(PARTNER_ROUTES.rewards.policy.roles).toEqual(['admin']);
  expect(PARTNER_ROUTES.rewards.nav).toBe(true);
});
