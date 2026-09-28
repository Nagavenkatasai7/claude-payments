import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { TWO_PARTNER_PHONE } from './helpers-portal-two-partner';

// UI redesign M2-13, Task 13.1: the customer portal Devices page. The REAL portal gate
// (portal-auth) and a REAL session store run over an in-memory Redis, so "a revoked session is
// refused on the next request" is proven end to end, not by a mocked gate.

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
  cookieSets: [] as Array<{ name: string; value: string; opts: Record<string, unknown> | undefined }>,
  redis: null as unknown,
  db: null as unknown,
  revalidated: [] as string[],
  storeOps: 0,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'acme.smartremit.ai', 'x-forwarded-for': '203.0.113.9' }),
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: Record<string, unknown>) => {
      h.cookieSets.push({ name: n, value: v, opts: o });
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
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/redis', () => ({
  getRedis: () =>
    new Proxy(
      {},
      {
        get:
          (_t, k: string) =>
          (...a: unknown[]) => {
            h.storeOps++;
            return (h.redis as Record<string, (...x: unknown[]) => unknown>)[k](...a);
          },
      },
    ),
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
let db: Db;
let redis: FakeRedis;
let now = Date.now();

const sessions = () => createPortalSessionStore(redis, { now: () => now });
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function signIn(partnerId = 'pa', phone = PHONE, device = 'Safari on iPhone') {
  return sessions().create(partnerId, phone, device);
}
async function useCookie(token: string) {
  h.jar.set(PORTAL_SESSION_COOKIE, token);
}
async function auditCount(partnerId: string, action: string) {
  return (await db.select().from(auditEvents).where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, action)))).length;
}

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
  redis = fakeRedis();
  h.redis = redis;
  h.db = db;
  h.site = SITE('pa', 'acme');
  h.jar = new Map();
  h.cookieSets = [];
  h.revalidated = [];
  h.storeOps = 0;
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const repo = createCustomerRepo(db, async () => null);
  await repo.upsertOnFirstInbound('pa', PHONE);
  await repo.upsertOnFirstInbound('pb', PHONE);
});

describe('listPortalDevices', () => {
  it("lists the customer's devices, most recent first, and marks the current one", async () => {
    const other = await signIn('pa', PHONE, 'Chrome on Windows');
    now += 60_000;
    const mine = await signIn('pa', PHONE, 'Safari on iPhone');
    await useCookie(mine.token);
    const rows = await listPortalDevices(await requirePortalCustomer());
    expect(rows.map((r) => r.sid)).toEqual([mine.sid, other.sid]);
    expect(rows.map((r) => r.current)).toEqual([true, false]);
    expect(rows[0].device).toBe('Safari on iPhone');
    // Only the closed-set label and times: never a token, a token hash or a phone.
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAtMs', 'current', 'device', 'lastSeenMs', 'sid']);
    expect(JSON.stringify(rows)).not.toContain(PHONE);
    expect(JSON.stringify(rows)).not.toContain(mine.token);
  });
});

describe('signOutDeviceAction', () => {
  it('signs out another of my devices: its session is refused on the next request, and it is audited', async () => {
    const other = await signIn('pa', PHONE, 'Chrome on Windows');
    const mine = await signIn();
    await useCookie(mine.token);
    expect(await signOutDeviceAction(null, fd({ sid: other.sid }))).toEqual({ notice: 'portal.devices.signed_out' });
    expect(await sessions().resolve(other.token, 'pa')).toBeNull();
    expect(await sessions().resolve(mine.token, 'pa')).not.toBeNull();
    // The next request carrying the revoked cookie is signed out.
    h.jar.set(PORTAL_SESSION_COOKIE, other.token);
    await expect(requirePortalCustomer()).rejects.toThrow('REDIRECT:/portal/login');
    expect(await auditCount('pa', 'portal.auth.signout_one')).toBe(1);
    expect(h.revalidated).toContain('/portal/devices');
  });

  it('a malformed or unknown sid gets the SAME copy and changes nothing (no oracle)', async () => {
    const mine = await signIn();
    await useCookie(mine.token);
    for (const sid of ['', 'not-a-sid', 'f'.repeat(32), `${'a'.repeat(31)}Z`]) {
      expect(await signOutDeviceAction(null, fd({ sid }))).toEqual({ notice: 'portal.devices.signed_out' });
    }
    expect(await sessions().resolve(mine.token, 'pa')).not.toBeNull();
    expect(await auditCount('pa', 'portal.auth.signout_one')).toBe(0);
  });

  it('posting my CURRENT sid is a normal sign-out: the cookie is cleared and I land on sign-in', async () => {
    const mine = await signIn();
    await useCookie(mine.token);
    await expect(signOutDeviceAction(null, fd({ sid: mine.sid }))).rejects.toThrow('REDIRECT:/portal/login');
    expect(await sessions().resolve(mine.token, 'pa')).toBeNull();
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(false);
    expect(h.cookieSets.at(-1)?.opts).toMatchObject({ maxAge: 0, secure: true, path: '/' });
    expect(await auditCount('pa', 'portal.auth.signout_one')).toBe(1);
  });

  it('without a session → sign-in; on the apex → 404 before any store read', async () => {
    await expect(signOutDeviceAction(null, fd({ sid: 'a'.repeat(32) }))).rejects.toThrow('REDIRECT:/portal/login');
    h.site = null;
    h.storeOps = 0;
    await expect(signOutDeviceAction(null, fd({ sid: 'a'.repeat(32) }))).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(h.storeOps).toBe(0);
  });
});

describe('signOutEverywhereAction', () => {
  it('needs a fresh step-up: a stale session goes to /portal/verify and nothing is revoked', async () => {
    const other = await signIn('pa', PHONE, 'Chrome on Windows');
    const mine = await signIn();
    await useCookie(mine.token);
    now += 16 * 60_000;
    await expect(signOutEverywhereAction()).rejects.toThrow('REDIRECT:/portal/verify?next=/portal/devices');
    expect(await sessions().resolve(other.token, 'pa')).not.toBeNull();
    expect(await auditCount('pa', 'portal.auth.signout_all')).toBe(0);
  });

  it('ends EVERY session including this one, clears the cookie, audits, and lands on sign-in', async () => {
    const other = await signIn('pa', PHONE, 'Chrome on Windows');
    const mine = await signIn();
    await useCookie(mine.token);
    await expect(signOutEverywhereAction()).rejects.toThrow('REDIRECT:/portal/login');
    expect(await sessions().resolve(other.token, 'pa')).toBeNull();
    expect(await sessions().resolve(mine.token, 'pa')).toBeNull();
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(false);
    expect(await auditCount('pa', 'portal.auth.signout_all')).toBe(1);
    // The proxy re-sets an existing cookie value on GETs; Redis is the authority, so a resurrected
    // cookie is still signed out on the next request.
    h.jar.set(PORTAL_SESSION_COOKIE, mine.token);
    await expect(requirePortalCustomer()).rejects.toThrow('REDIRECT:/portal/login');
    expect(await sessions().list('pa', PHONE)).toEqual([]);
  });

  it('a store failure while ending the other sessions still ends THIS one and clears the cookie', async () => {
    const mine = await signIn();
    await useCookie(mine.token);
    const store = (await import('@/lib/portal-session-store')).getPortalSessionStore();
    const spy = vi.spyOn(store, 'revokeAll').mockRejectedValueOnce(new Error('redis down'));
    await expect(signOutEverywhereAction()).rejects.toThrow('redis down');
    spy.mockRestore();
    expect(await sessions().resolve(mine.token, 'pa')).toBeNull();
    expect(h.jar.has(PORTAL_SESSION_COOKIE)).toBe(false);
  });

  it('the audit row carries no phone', async () => {
    const mine = await signIn();
    await useCookie(mine.token);
    await expect(signOutEverywhereAction()).rejects.toThrow('REDIRECT:/portal/login');
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.action, 'portal.auth.signout_all'));
    expect(JSON.stringify(rows)).not.toContain(PHONE);
  });
});

describe('copy', () => {
  it('everywhereBody copy does not promise a WhatsApp code every time (step-up may already be fresh, or ask for TOTP)', async () => {
    const { en } = await import('@/lib/i18n/catalogues/en');
    const body = (en as Record<string, string>)['portal.devices.everywhereBody'];
    expect(body).not.toMatch(/fresh WhatsApp code first/);
    expect(body).toMatch(/confirm it’s you/);
  });
});
