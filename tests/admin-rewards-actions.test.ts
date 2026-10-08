import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';

// B3 rewards v1: the /admin-dashboard/rewards server actions. Platform ADMIN
// only (a platform agent, a partner admin and anonymous are refused before
// any write). The catalog sets what partners may offer; the terms set one
// partner's platform fee, give-back and monthly budget. Each save writes ONE
// audit row in the same transaction.

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
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
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});

import { auditEvents, partnerRewardTerms, rewardCatalog } from '@/db/schema';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { DEFAULT_TERMS } from '@/lib/rewards/settings';
import { saveCatalogAction, saveTermsAction } from '@/app/admin-dashboard/rewards/actions';

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const CATALOG_FORM = {
  kind: 'nth_transfer', available: 'on', nthMin: '3', nthMax: '10', maxDays: '14', maxDiscountUsd: '2.99', customerMonthlyCap: '1', festivalNames: '',
};
const TERMS_FORM = { partnerId: 'pa', platformFeeUsd: '0.60', giveBackPct: '40', monthlyBudgetUsd: '250' };

const snapshot = async () => ({
  catalog: (await db.select().from(rewardCatalog)).length,
  terms: (await db.select().from(partnerRewardTerms)).length,
  audits: (await db.select().from(auditEvents)).length,
});

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  revalidatePath.mockClear();
  db = await freshDb();
  await seedTwoTenants(db);
});

const signInPlatformAdmin = () => signInAs(redis, cookieJar, { username: 'root', role: 'admin', partnerId: undefined });

describe('/admin-dashboard/rewards actions: the gate', () => {
  it('anonymous, a platform agent and a partner admin are refused, nothing written', async () => {
    const before = await snapshot();
    for (const act of [() => saveCatalogAction(null, form(CATALOG_FORM)), () => saveTermsAction(null, form(TERMS_FORM))]) {
      cookieJar.clear();
      await expect(act()).rejects.toThrow(/^REDIRECT:/);
      await signInAs(redis, cookieJar, { username: 'platform-agent', role: 'agent', partnerId: undefined });
      await expect(act()).rejects.toThrow(/^REDIRECT:/);
      await signInAs(redis, cookieJar, { username: 'pa-admin', role: 'admin', partnerId: 'pa' });
      await expect(act()).rejects.toThrow(/^REDIRECT:/);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses on a partner-site host', async () => {
    await signInPlatformAdmin();
    host.value = 'acme.smartremit.ai';
    await expect(saveCatalogAction(null, form(CATALOG_FORM))).rejects.toThrow();
    expect((await snapshot()).catalog).toBe(0);
  });
});

describe('/admin-dashboard/rewards actions: the writes', () => {
  it('the catalog saves with one audit row; bad values are refused', async () => {
    await signInPlatformAdmin();
    expect(await saveCatalogAction(null, form(CATALOG_FORM))).toEqual({ ok: true });
    expect((await createRewardRepo(db).getCatalog()).nth_transfer).toMatchObject({ available: true, nthMin: 3, nthMax: 10 });
    const rows = await db.select().from(auditEvents).orderBy(asc(auditEvents.id));
    expect(rows.map((r) => r.action)).toEqual(['rewards.catalog']);
    expect(revalidatePath).toHaveBeenCalledWith('/admin-dashboard/rewards');

    const before = await snapshot();
    expect(await saveCatalogAction(null, form({ ...CATALOG_FORM, nthMin: '9', nthMax: '4' }))).toMatchObject({ ok: false });
    expect(await saveCatalogAction(null, form({ ...CATALOG_FORM, kind: 'first_transfer' }))).toMatchObject({ ok: false });
    expect(await saveCatalogAction(null, form({ ...CATALOG_FORM, kind: 'festival', festivalNames: '<script>' }))).toMatchObject({ ok: false });
    expect(await snapshot()).toEqual(before);
  });

  it('terms save for the named partner only; an unknown partner is refused', async () => {
    await signInPlatformAdmin();
    expect(await saveTermsAction(null, form(TERMS_FORM))).toEqual({ ok: true });
    expect(await createRewardRepo(db).getTerms('pa')).toEqual({ platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 250 });
    expect(await createRewardRepo(db).getTerms('pb')).toEqual(DEFAULT_TERMS);
    const before = await snapshot();
    expect(await saveTermsAction(null, form({ ...TERMS_FORM, partnerId: 'nope' }))).toMatchObject({ ok: false });
    expect(await saveTermsAction(null, form({ ...TERMS_FORM, partnerId: '' }))).toMatchObject({ ok: false });
    expect(await saveTermsAction(null, form({ ...TERMS_FORM, giveBackPct: '101' }))).toMatchObject({ ok: false });
    expect(await saveTermsAction(null, form({ ...TERMS_FORM, monthlyBudgetUsd: '-5' }))).toMatchObject({ ok: false });
    expect(await snapshot()).toEqual(before);
  });
});
