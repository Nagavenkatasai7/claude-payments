import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

// Lost-features p2 A11: "Find by phone" on /partner/customers. A POST (the phone travels in the body
// only) that redirects to the sealed ref of THIS tenant's customer. Nothing is disclosed (the
// detail page writes pii.view), so no audit row; another tenant's customer is "none".
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
let host = 'smartremit.ai';
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
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
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});

import { openCustomerRef } from '@/lib/customer-ref';
import { findCustomerAction } from '@/app/partner/(app)/customers/actions';

const A_PHONE = '15551230000';
const B_ONLY = '15558882222';
const form = (phone: string) => {
  const fd = new FormData();
  fd.set('phone', phone);
  return fd;
};
const customer = (o: Partial<Customer>): Customer =>
  ({ senderPhone: A_PHONE, firstSeenAt: new Date().toISOString(), kycStatus: 'verified', senderCountry: 'US', partnerId: 'pa', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o }) as Customer;
async function auditCount() {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`);
  return Number((res as unknown as { rows: Array<{ n: number }> }).rows[0].n);
}
const refOf = (err: unknown) => {
  const m = /^REDIRECT:\/partner\/customers\/(.+)$/.exec((err as Error).message);
  return m ? openCustomerRef(m[1]) : null;
};

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, 'pa', 'A');
  await seedPartner(db, 'pb', 'B');
  const cs = createCustomerStore(db, createStore(redis, db));
  await cs.saveCustomer(customer({ partnerId: 'pa' }));
  await cs.saveCustomer(customer({ partnerId: 'pb' }));
  await cs.saveCustomer(customer({ partnerId: 'pb', senderPhone: B_ONLY }));
});

describe('findCustomerAction: gate', () => {
  it('a partner-site host is refused first', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    host = 'acme.smartremit.ai';
    await expect(findCustomerAction(form(A_PHONE))).rejects.toThrow('NOT_FOUND');
  });
  it('anonymous → /login; platform → /admin-dashboard; support and finance → /partner', async () => {
    await expect(findCustomerAction(form(A_PHONE))).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined });
    await expect(findCustomerAction(form(A_PHONE))).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(findCustomerAction(form(A_PHONE))).rejects.toThrow(/^REDIRECT:\/partner$/);
    }
  });
});

describe('findCustomerAction: the lookup', () => {
  it('admin and agent: own customer → redirect to the sealed ref of (A, phone); the URL holds no phone; no audit row', async () => {
    for (const role of ['admin', 'agent'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      const err = await findCustomerAction(form('+1 (555) 123-0000')).catch((e: unknown) => e);
      expect(refOf(err)).toEqual({ partnerId: 'pa', phone: A_PHONE });
      expect((err as Error).message).not.toContain('1230000');
    }
    expect(await auditCount()).toBe(0);
  });
  it('a forged tenant field is ignored: the same phone resolves at A only', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    const fd = form(A_PHONE);
    fd.set('partnerId', 'pb');
    fd.set('partner', 'pb');
    const err = await findCustomerAction(fd).catch((e: unknown) => e);
    expect(refOf(err)?.partnerId).toBe('pa');
  });
  it('B’s customer that A lacks → none (no cross-tenant oracle)', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    expect(await findCustomerAction(form(B_ONLY))).toEqual({ ok: false, error: 'No customer with that phone number.' });
  });
  it('a short, long or junk number → invalid', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    for (const p of ['12345', '1234567890123456', '', 'abc']) {
      expect(await findCustomerAction(form(p)), p).toEqual({ ok: false, error: 'Enter a full phone number with country code.' });
    }
    expect(await findCustomerAction(new FormData())).toEqual({ ok: false, error: 'Enter a full phone number with country code.' });
  });
});
