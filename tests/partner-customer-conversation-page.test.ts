import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer, Staff } from '@/lib/types';

// Lost-features p2 A8: /partner/customers/conversation/[ref], the admin-only conversation log. The
// read spends one reveal-budget unit, then writes ONE conversation.view row before any text shows.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const fail = { audit: false, redis: false };
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({
  getRedis: () =>
    fail.redis
      ? new Proxy(redis, {
          get: (target, p, r) =>
            p === 'incr' ? async () => Promise.reject(new Error('redis down')) : Reflect.get(target, p, r),
        })
      : redis,
}));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});
vi.mock('@/db/repos/aux-repos', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/aux-repos')>('@/db/repos/aux-repos');
  return {
    ...actual,
    createAuditRepo: (d: Parameters<typeof actual.createAuditRepo>[0]) => {
      const repo = actual.createAuditRepo(d);
      if (fail.audit) repo.record = async () => Promise.reject(new Error('audit down'));
      return repo;
    },
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { auditSubjectId, sealCustomerRef } from '@/lib/customer-ref';
import { createConversationLogRepo } from '@/db/repos/conversation-log-repo';
import { REVEAL_LIMIT, revealThrottleKey } from '@/lib/partner-reveal-throttle';
import ConversationPage from '@/app/partner/(app)/customers/conversation/[ref]/page';
import ConversationIndex from '@/app/partner/(app)/customers/conversation/page';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const SHARED = '15551230000';
const QUIET = '15557770000';
const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = { username: 'u1', name: 'U', role: 'admin', permissions: perms, passwordHash: 'x', createdAt: new Date().toISOString(), ...o };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
const customer = (o: Partial<Customer>): Customer =>
  ({ senderPhone: SHARED, firstSeenAt: new Date().toISOString(), kycStatus: 'verified', senderCountry: 'US', partnerId: PA, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o }) as Customer;
const page = async (ref: string) => renderToStaticMarkup(await ConversationPage({ params: Promise.resolve({ ref }) }));
async function views() {
  const res = await db.execute(sql`SELECT partner_id, actor, subject_id, meta FROM audit_events WHERE action = 'conversation.view'`);
  return (res as unknown as { rows: Array<{ partner_id: string; actor: string; subject_id: string; meta: Record<string, unknown> }> }).rows;
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  fail.audit = false;
  fail.redis = false;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha');
  await seedPartner(db, PB, 'Bravo');
  const cs = createCustomerStore(db, createStore(redis, db));
  await cs.saveCustomer(customer({ partnerId: PA }));
  await cs.saveCustomer(customer({ partnerId: PA, senderPhone: QUIET }));
  await cs.saveCustomer(customer({ partnerId: PB }));
  const log = createConversationLogRepo(db);
  await log.append({ partnerId: PA, phone: SHARED, channel: 'wa', direction: 'in', text: 'alpha hello there' });
  await log.append({ partnerId: PA, phone: SHARED, channel: 'wa', direction: 'out', text: 'alpha reply text' });
  await log.append({ partnerId: PB, phone: SHARED, channel: 'wa', direction: 'in', text: 'bravo secret text' });
});

describe('conversation log: gate', () => {
  it('anonymous → /login; platform → /admin-dashboard; agent, support and finance → /partner; no audit', async () => {
    const ref = sealCustomerRef(PA, SHARED);
    await expect(page(ref)).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(page(ref)).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs({ username: `pa-${role}`, partnerId: PA, role });
      await expect(page(ref)).rejects.toThrow(/^REDIRECT:\/partner$/);
    }
    expect(await views()).toHaveLength(0);
  });
  it('the bare path gates the same way and sends an admin back to Customers', async () => {
    await expect(ConversationIndex()).rejects.toThrow('REDIRECT:/login');
    await signInAs({ username: 'pa-agent', partnerId: PA, role: 'agent' });
    await expect(ConversationIndex()).rejects.toThrow(/^REDIRECT:\/partner$/);
    await signInAs({ partnerId: PA, role: 'admin' });
    await expect(ConversationIndex()).rejects.toThrow('REDIRECT:/partner/customers');
  });
});

describe('conversation log: tenant isolation', () => {
  it('a foreign ref (even the same phone at B), junk, or a phone A lacks → NOT_FOUND, no audit, no budget spent', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    for (const ref of [sealCustomerRef(PB, SHARED), sealCustomerRef(PA, '15550009999'), 'junk', SHARED]) {
      await expect(page(ref), ref).rejects.toThrow('NOT_FOUND');
    }
    expect(await views()).toHaveLength(0);
    expect([...redis.dump.keys()].some((k) => k.startsWith('pii:reveal'))).toBe(false);
  });
});

describe('conversation log: the read', () => {
  it('own customer: the thread, and ONE partner-marked conversation.view row with no text or phone', async () => {
    await signInAs({ partnerId: PA, role: 'admin', username: 'pa-adm' });
    const html = await page(sealCustomerRef(PA, SHARED));
    expect(html).toContain('alpha hello there');
    expect(html).toContain('alpha reply text');
    expect(html).not.toContain('bravo secret');
    expect(html).not.toContain(SHARED);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const rows = await views();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: PA, actor: 'pa-adm', subject_id: auditSubjectId(PA, SHARED) });
    expect(rows[0].meta).toMatchObject({ count: 2, channel: 'wa', actorScope: 'partner' });
    expect(JSON.stringify(rows[0])).not.toMatch(/alpha hello|alpha reply|15551230000/);
  });
  it('the back link has prefetch off and no phone', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await page(sealCustomerRef(PA, SHARED));
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).not.toContain('1230000');
  });
  it('an empty thread writes no row', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    expect(await page(sealCustomerRef(PA, QUIET))).toContain('No logged messages yet.');
    expect(await views()).toHaveLength(0);
  });
  it('an audit write failure renders no text (the page fails)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    fail.audit = true;
    await expect(page(sealCustomerRef(PA, SHARED))).rejects.toThrow('audit down');
  });
  it('the throttle: over budget shows fixed copy, no text, no row; a Redis error does the same', async () => {
    await signInAs({ partnerId: PA, role: 'admin', username: 'pa-busy' });
    for (let i = 0; i < REVEAL_LIMIT; i++) await redis.incr(revealThrottleKey(PA, 'pa-busy', Date.now()));
    let html = await page(sealCustomerRef(PA, SHARED));
    expect(html).toContain('data-conversation-busy');
    expect(html).not.toContain('alpha hello');
    redis.dump.clear();
    await signInAs({ partnerId: PA, role: 'admin', username: 'pa-redis' });
    fail.redis = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    html = await page(sealCustomerRef(PA, SHARED));
    warn.mockRestore();
    expect(html).toContain('data-conversation-busy');
    expect(html).not.toContain('alpha hello');
    expect(await views()).toHaveLength(0);
  });
});
