import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Db } from '@/db/client';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { TWO_PARTNER_PHONE } from './helpers-portal-two-partner';

// UI redesign M2-13 (Review Focus 1, tenant isolation): a customer's Devices page and its sign-out
// actions act ONLY on (host partner, session phone). The same phone under partner B, and another
// customer on the same partner, are invisible and unrevocable. Real gate, real store.

const SITE = (partnerId: string, slug: string) => ({
  partnerId,
  slug,
  brand: `Brand ${slug}`,
  logo: null,
  theme: { primary: '#0c5bd2', accent: '#0e7490', primaryFromPartner: false, accentFromPartner: false },
});

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  jar: new Map<string, string>(),
  redis: null as unknown,
  db: null as unknown,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'acme.smartremit.ai' }),
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: Record<string, unknown>) => {
      if (o?.maxAge === 0) h.jar.delete(n);
      else h.jar.set(n, v);
    },
    delete: (n: string) => h.jar.delete(n),
  }),
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/redis', () => ({
  getRedis: () =>
    new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (h.redis as Record<string, (...x: unknown[]) => unknown>)[k](...a) }),
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => h.db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => ({}) }));
vi.mock('@/lib/customer-store', async () => {
  const { createCustomerRepo } = await import('@/db/repos/customer-repo');
  return { getCustomerStore: () => createCustomerRepo(h.db as never, async () => null) };
});
vi.mock('@/lib/customer-mfa', () => ({ getCustomerMfaStore: () => ({ isEnrolled: async () => false }) }));

import { requirePortalCustomer } from '@/lib/portal-auth';
import { createPortalSessionStore, PORTAL_SESSION_COOKIE } from '@/lib/portal-session-store';
import { listPortalDevices } from '@/lib/portal-devices';
import { signOutDeviceAction, signOutEverywhereAction } from '@/app/portal/devices/actions';
import { createCustomerRepo } from '@/db/repos/customer-repo';

const PHONE = TWO_PARTNER_PHONE;
const OTHER_PHONE = '14155550199';
let db: Db;
let redis: FakeRedis;

const sessions = () => createPortalSessionStore(redis);
const fd = (sid: string) => {
  const f = new FormData();
  f.set('sid', sid);
  return f;
};
const signedInOn = async (partnerId: string, slug: string, token: string) => {
  h.site = SITE(partnerId, slug);
  h.jar.set(PORTAL_SESSION_COOKIE, token);
};

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  redis = fakeRedis();
  h.redis = redis;
  h.db = db;
  h.jar = new Map();
  const repo = createCustomerRepo(db, async () => null);
  await repo.upsertOnFirstInbound('pa', PHONE);
  await repo.upsertOnFirstInbound('pb', PHONE);
  await repo.upsertOnFirstInbound('pa', OTHER_PHONE);
});

describe('devices: same phone, two partners', () => {
  it("B's sessions are never listed on A's host", async () => {
    const a = await sessions().create('pa', PHONE, 'Safari on iPhone');
    const b = await sessions().create('pb', PHONE, 'Chrome on Windows');
    await signedInOn('pa', 'acme', a.token);
    const sids = (await listPortalDevices(await requirePortalCustomer())).map((d) => d.sid);
    expect(sids).toEqual([a.sid]);
    expect(sids).not.toContain(b.sid);
  });

  it("posting B's sid on A's host gets the same copy and B stays signed in", async () => {
    const a = await sessions().create('pa', PHONE, 'Safari on iPhone');
    const b = await sessions().create('pb', PHONE, 'Chrome on Windows');
    await signedInOn('pa', 'acme', a.token);
    expect(await signOutDeviceAction(null, fd(b.sid))).toEqual({ notice: 'portal.devices.signed_out' });
    expect(await sessions().resolve(b.token, 'pb')).not.toBeNull();
  });

  it('signing out everywhere on A leaves the B session alive', async () => {
    const a = await sessions().create('pa', PHONE, 'Safari on iPhone');
    const b = await sessions().create('pb', PHONE, 'Chrome on Windows');
    await signedInOn('pa', 'acme', a.token);
    await expect(signOutEverywhereAction()).rejects.toThrow('REDIRECT:/portal/login');
    expect(await sessions().resolve(a.token, 'pa')).toBeNull();
    expect(await sessions().resolve(b.token, 'pb')).not.toBeNull();
  });

  it("A's cookie on B's host cannot reach B's devices at all", async () => {
    const a = await sessions().create('pa', PHONE, 'Safari on iPhone');
    const b = await sessions().create('pb', PHONE, 'Chrome on Windows');
    await signedInOn('pb', 'bravo', a.token);
    await expect(signOutDeviceAction(null, fd(b.sid))).rejects.toThrow('REDIRECT:/portal/login');
    await expect(signOutEverywhereAction()).rejects.toThrow('REDIRECT:/portal/login');
    expect(await sessions().resolve(b.token, 'pb')).not.toBeNull();
  });
});

describe('devices: two customers, one partner', () => {
  it("customer X never sees or revokes customer Y's sessions", async () => {
    const x = await sessions().create('pa', PHONE, 'Safari on iPhone');
    const y = await sessions().create('pa', OTHER_PHONE, 'Chrome on Windows');
    await signedInOn('pa', 'acme', x.token);
    expect((await listPortalDevices(await requirePortalCustomer())).map((d) => d.sid)).toEqual([x.sid]);
    expect(await signOutDeviceAction(null, fd(y.sid))).toEqual({ notice: 'portal.devices.signed_out' });
    expect(await sessions().resolve(y.token, 'pa')).not.toBeNull();
    await expect(signOutEverywhereAction()).rejects.toThrow('REDIRECT:/portal/login');
    expect(await sessions().resolve(y.token, 'pa')).not.toBeNull();
  });
});
