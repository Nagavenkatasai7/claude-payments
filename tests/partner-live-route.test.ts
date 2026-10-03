import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { StaffRole } from '@/lib/types';

// Lost-features A15: GET /partner/live, the polling target of the /partner live refresher. An
// opaque stamp only, 401 (never a redirect) on any refusal, the session never refreshed by a poll,
// and the stamp covers only what the role may see.
const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined) }),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => {
  const actual = await orig<typeof import('@/lib/store')>();
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/auth-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth-store')>();
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-store')>();
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});

import { GET } from '@/app/partner/live/route';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { sql } from 'drizzle-orm';

const as = (role: StaffRole, o: { username?: string; partnerId?: string | undefined } = {}) =>
  signInAs(redis, cookieJar, { username: o.username ?? `pa-${role}`, partnerId: 'partnerId' in o ? o.partnerId : 'pa', role });
const poll = async () => {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('cache-control') };
};
const stampOf = async () => {
  const r = await poll();
  expect(r.status).toBe(200);
  return r.body.stamp as string;
};
/** The 15 s cache running out. */
const expireCache = () => {
  for (const k of [...redis.dump.keys()]) if (k.startsWith('plive:')) redis.dump.delete(k);
};
const ticket = (partnerId: string, id: string) =>
  createTicketRepo(db).createTicket({ id, partnerId, kind: 'customer', customerPhone: '14155550101', subject: 'Help', body: 'Where is my money' });

beforeEach(async () => {
  db = await freshDb();
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  await seedTwoTenants(db);
});

describe('GET /partner/live: refusals are 401 with an empty body', () => {
  it('anonymous', async () => {
    expect(await poll()).toEqual({ status: 401, body: {}, cache: 'no-store' });
  });
  it('a platform account', async () => {
    await as('admin', { username: 'plat', partnerId: undefined });
    expect((await poll()).status).toBe(401);
  });
  it('a suspended member, and a member of a suspended partner', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-susp', partnerId: 'pa', role: 'agent', status: 'suspended' });
    expect((await poll()).status).toBe(401);
    await as('agent');
    await db.execute(sql`UPDATE partners SET status = 'suspended' WHERE id = 'pa'`);
    expect((await poll()).status).toBe(401);
  });
  it('a member still waiting to enrol in two-step sign-in', async () => {
    await as('agent');
    await redis.set(`${MFA_PENDING_PREFIX}pa-agent`, '1');
    expect(await poll()).toEqual({ status: 401, body: {}, cache: 'no-store' });
  });
  it('a partner subdomain', async () => {
    await as('agent');
    host.value = 'acme.smartremit.ai';
    expect((await poll()).status).toBe(401);
  });
});

describe('GET /partner/live: the stamp', () => {
  it('is the only field: 64 hex chars, no-store, no figure', async () => {
    await seedPartnerTransfer(db, { id: 'tA1', partnerId: 'pa' });
    await as('admin');
    const r = await poll();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['stamp']);
    expect(r.body.stamp).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cache).toBe('no-store');
  });

  it("moves with the tenant's own transfers, never with another tenant's", async () => {
    await as('agent');
    const a0 = await stampOf();
    await seedPartnerTransfer(db, { id: 'tB1', partnerId: 'pb' });
    expireCache();
    expect(await stampOf()).toBe(a0);
    await seedPartnerTransfer(db, { id: 'tA1', partnerId: 'pa' });
    expireCache();
    expect(await stampOf()).not.toBe(a0);
  });

  it('support: tickets move it, transfers never do; finance: the other way round', async () => {
    await as('support');
    const s0 = await stampOf();
    await seedPartnerTransfer(db, { id: 'tA1', partnerId: 'pa' });
    expireCache();
    expect(await stampOf()).toBe(s0);
    await ticket('pa', 'tk_a1');
    expireCache();
    const s1 = await stampOf();
    expect(s1).not.toBe(s0);

    await as('finance');
    const f0 = await stampOf();
    await ticket('pa', 'tk_a2');
    expireCache();
    expect(await stampOf()).toBe(f0);
  });

  it('is cached 15 s per tenant under a hashed key (no tenant id in Redis keys)', async () => {
    await as('agent');
    await stampOf();
    const keys = [...redis.dump.keys()].filter((k) => k.startsWith('plive:'));
    const h = createHash('sha256').update('pa').digest('hex');
    expect(keys.sort()).toEqual([`plive:${h}:money`, `plive:${h}:tickets`]);
    // Within the window a new transfer does not move it yet.
    const a0 = await stampOf();
    await seedPartnerTransfer(db, { id: 'tA1', partnerId: 'pa' });
    expect(await stampOf()).toBe(a0);
  });

  it('a Redis cache error still answers (computed directly)', async () => {
    await as('agent');
    const get = redis.get.bind(redis);
    const spy = vi.spyOn(redis, 'get').mockImplementation(async (k: string) => {
      if (k.startsWith('plive:')) throw new Error('redis down');
      return get(k);
    });
    try {
      expect((await poll()).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('a poll never refreshes the session (the idle sign-out is not extended)', async () => {
    await as('agent');
    const tokenHash = createHash('sha256').update(cookieJar.get(SESSION_COOKIE)!).digest('hex');
    const seenKey = `staff_sess_seen:${tokenHash}`;
    const created = Date.now() - 10 * 60_000;
    const seen = `${created}:${Date.now() - 5 * 60_000}`; // last real request 5 min ago
    redis.dump.set(seenKey, seen);
    expect((await poll()).status).toBe(200);
    expect(redis.dump.get(seenKey)).toBe(seen);
  });
});
