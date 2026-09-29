import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-18, Task 18.3: the PLATFORM-only slug change (admin-dashboard partner page). The
// REAL gate (requirePlatformAdmin over a real session on a fake Redis) and the real writer on PGlite.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
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
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditEvents, partnerSites, partnerSlugTombstones } from '@/db/schema';
import { changePartnerSlugAction } from '@/app/admin-dashboard/partners/actions';
import { setPartnerSlug } from '@/db/repos/partner-site-repo';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const REASON = 'Partner rebranded, ticket 1234';

async function signInAs(o: Partial<Staff>): Promise<Staff> {
  const s: Staff = {
    username: 'ops',
    name: 'Ops',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.clear();
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
  return s;
}
function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
const changeForm = (o: Record<string, string> = {}) => form({ id: PA, slug: 'alpha-two', reason: REASON, ...o });
const siteOf = async (id: string) => (await db.select().from(partnerSites).where(eq(partnerSites.partnerId, id)))[0] ?? null;
const snapshot = async () => ({
  sites: await db.select().from(partnerSites),
  tombstones: await db.select().from(partnerSlugTombstones),
  audits: (await db.select().from(auditEvents)).length,
});

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha');
  await seedPartner(db, PB, 'Bravo');
  await setPartnerSlug(db, PA, 'alpha-co', 'pa-admin', { redis, actorScope: 'partner' });
  vi.clearAllMocks();
});

describe('changePartnerSlugAction (platform only)', () => {
  it('refuses on a partner-site host before anything else', async () => {
    await signInAs({});
    host.value = 'alpha-co.smartremit.ai';
    const before = await snapshot();
    await expect(changePartnerSlugAction(changeForm())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(await snapshot()).toEqual(before);
  });
  it('a partner admin (any tenant) posting to it is redirected by requirePlatformAdmin, with no write', async () => {
    const before = await snapshot();
    await expect(changePartnerSlugAction(changeForm())).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'pa-admin', partnerId: PA });
    await expect(changePartnerSlugAction(changeForm())).rejects.toThrow('REDIRECT:/admin-dashboard');
    await signInAs({ username: 'plat-agent', role: 'agent' });
    await expect(changePartnerSlugAction(changeForm())).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await snapshot()).toEqual(before);
  });
  it('a reason under 10 characters (or none) is refused before any write', async () => {
    await signInAs({});
    const before = await snapshot();
    await expect(changePartnerSlugAction(changeForm({ reason: 'short' }))).rejects.toThrow(/at least 10/);
    await expect(changePartnerSlugAction(changeForm({ reason: '' }))).rejects.toThrow(/reason is required/i);
    expect(await snapshot()).toEqual(before);
  });
  it('an unknown partner id is refused with no write', async () => {
    await signInAs({});
    const before = await snapshot();
    await expect(changePartnerSlugAction(changeForm({ id: 'ptn-nope00' }))).rejects.toThrow(/not found/i);
    expect(await snapshot()).toEqual(before);
  });
  it('success: moves the partner, tombstones the old slug, one audit row with actorScope platform + reason', async () => {
    await signInAs({});
    await changePartnerSlugAction(changeForm({ slug: '  Alpha-Two ' }));
    expect(await siteOf(PA)).toMatchObject({ slug: 'alpha-two' });
    expect(await db.select({ slug: partnerSlugTombstones.slug, partnerId: partnerSlugTombstones.partnerId, releasedBy: partnerSlugTombstones.releasedBy }).from(partnerSlugTombstones))
      .toEqual([{ slug: 'alpha-co', partnerId: PA, releasedBy: 'ops' }]);
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'partner.slug.update'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: PA, actor: 'ops', actorType: 'staff', subjectId: PA });
    expect(rows[0]!.meta).toEqual({ slug: 'alpha-two', previousSlug: 'alpha-co', actorScope: 'platform', reason: REASON });
    expect(revalidatePath).toHaveBeenCalledWith(`/admin-dashboard/partners/${PA}`);
  });
  it('the platform can not move a partner back to a tombstoned slug, nor onto a taken or reserved one', async () => {
    await signInAs({});
    await changePartnerSlugAction(changeForm());
    await setPartnerSlug(db, PB, 'bravo-co', 'pb-admin', { redis });
    const before = await snapshot();
    for (const slug of ['alpha-co', 'bravo-co', 'www', 'bad_slug']) {
      await expect(changePartnerSlugAction(changeForm({ slug })), slug).rejects.toThrow(/not available/i);
    }
    expect(await snapshot()).toEqual(before);
  });
});
