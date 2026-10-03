import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { seedTwoTenants, signInAs } from './helpers-partner-app';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer } from '@/lib/types';

// Lost-features p2 A5: createCustomerAction. A compliance write: the partner-site host guard, the
// PARTNER_ADMIN gate, the session tenant only, insert-if-absent (never an overwrite), and the row
// commits with its customer.create audit row (plus kyc.manual_override.create when verified) in ONE
// transaction. Verified only in delegated KYC mode. The redirect carries the sealed ref, never digits.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
let host = 'smartremit.ai';
const revalidated: string[] = [];
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
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));
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

import { auditSubjectId, openCustomerRef } from '@/lib/customer-ref';
import { createCustomerAction } from '@/app/partner/(app)/customers/new/actions';

const PHONE = '15551230000';
const form = (o: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set('phone', PHONE);
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const cs = () => createCustomerStore(db, createStore(redis, db));
type AuditRow = { partner_id: string; actor: string; action: string; subject_id: string; meta: Record<string, unknown> };
async function audits(): Promise<AuditRow[]> {
  const res = await db.execute(sql`SELECT partner_id, actor, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (res as unknown as { rows: AuditRow[] }).rows;
}
async function customerCount(): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM customers`);
  return Number((res as unknown as { rows: Array<{ n: number }> }).rows[0].n);
}
const refOf = (err: unknown) => {
  const m = /^REDIRECT:\/partner\/customers\/(.+)$/.exec((err as Error).message);
  return m ? openCustomerRef(m[1]) : null;
};
const delegate = (id: string) => db.execute(sql.raw(`UPDATE partners SET kyc_mode = 'delegated' WHERE id = '${id}'`));

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  revalidated.length = 0;
  host = 'smartremit.ai';
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedTwoTenants(db);
  await db.execute(sql.raw(`UPDATE partners SET countries = '["US","GB"]'::jsonb`));
});

describe('createCustomerAction: gate', () => {
  it('a partner-site host is refused first, with nothing written', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    host = 'acme.smartremit.ai';
    await expect(createCustomerAction(form())).rejects.toThrow('NOT_FOUND');
    expect(await customerCount()).toBe(0);
  });
  it('anonymous → /login; platform → /admin-dashboard; agent, support and finance → /partner; nothing written', async () => {
    await expect(createCustomerAction(form())).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined });
    await expect(createCustomerAction(form())).rejects.toThrow('REDIRECT:/admin-dashboard');
    for (const role of ['agent', 'support', 'finance'] as const) {
      await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
      await expect(createCustomerAction(form())).rejects.toThrow(/^REDIRECT:\/partner$/);
    }
    expect(await customerCount()).toBe(0);
    expect(await audits()).toEqual([]);
  });
});

describe('createCustomerAction: the create', () => {
  it('admin: creates at the SESSION tenant (forged tenant fields ignored), one customer.create row, redirect to the sealed ref with no phone digits', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    const fd = form({ fullName: 'Asha Rao', partnerId: 'pb', partner: 'pb' });
    const err = await createCustomerAction(fd).catch((e: unknown) => e);
    expect(refOf(err)).toEqual({ partnerId: 'pa', phone: PHONE });
    expect((err as Error).message).not.toContain('1230000');
    expect(await cs().getCustomer('pa', PHONE)).toMatchObject({ partnerId: 'pa', fullName: 'Asha Rao', kycStatus: 'not_started', senderCountry: 'US' });
    expect((await cs().getCustomer('pa', PHONE))?.optInAt).toBeUndefined();
    expect(await cs().getCustomer('pb', PHONE)).toBeNull();
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'pa',
      actor: 'pa-admin',
      action: 'customer.create',
      subject_id: auditSubjectId('pa', PHONE),
      meta: { kycStatus: 'not_started', senderCountry: 'US', source: 'manual', actorScope: 'partner' },
    });
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain('Asha');
    expect(raw).not.toContain(PHONE);
    expect(revalidated).toContain('/partner/customers');
  });
  it('an existing phone at A is not overwritten: fixed copy, no audit row', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    const now = new Date().toISOString();
    await cs().saveCustomer({ senderPhone: PHONE, partnerId: 'pa', kycStatus: 'pending', fullName: 'Original Name', senderCountry: 'US', firstSeenAt: now, createdAt: now, updatedAt: now } as Customer);
    expect(await createCustomerAction(form({ fullName: 'Other Name' }))).toEqual({
      ok: false,
      error: 'You already have a customer with this phone number. Nothing was changed.',
    });
    expect(await cs().getCustomer('pa', PHONE)).toMatchObject({ fullName: 'Original Name', kycStatus: 'pending' });
    expect(await audits()).toEqual([]);
  });
  it('the same phone at B does not block A (the key is the tenant and the phone)', async () => {
    const now = new Date().toISOString();
    await cs().saveCustomer({ senderPhone: PHONE, partnerId: 'pb', kycStatus: 'verified', senderCountry: 'US', firstSeenAt: now, createdAt: now, updatedAt: now } as Customer);
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    const err = await createCustomerAction(form()).catch((e: unknown) => e);
    expect(refOf(err)).toEqual({ partnerId: 'pa', phone: PHONE });
    expect(await cs().getCustomer('pb', PHONE)).toMatchObject({ kycStatus: 'verified' });
  });
  it('invalid input → fixed copy, nothing written', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    expect(await createCustomerAction(form({ phone: '123' }))).toEqual({ ok: false, error: expect.any(String) });
    expect(await createCustomerAction(form({ country: 'IN' }))).toEqual({ ok: false, error: 'Pick a sending country from your list.' });
    expect(await createCustomerAction(form({ kycStatus: 'grandfathered', reason: 'A long enough reason' }))).toEqual({
      ok: false,
      error: 'Pick a verification status from the list.',
    });
    expect(await customerCount()).toBe(0);
    expect(await audits()).toEqual([]);
  });
});

describe('createCustomerAction: verified (delegated KYC only)', () => {
  it('ours mode: verified is refused, nothing written', async () => {
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    expect(await createCustomerAction(form({ kycStatus: 'verified', reason: 'Checked passport in branch' }))).toEqual({
      ok: false,
      error: 'SmartRemit runs verification for your customers, so they start as not started.',
    });
    expect(await customerCount()).toBe(0);
  });
  it('delegated mode: the row carries the approval stamps and BOTH audit rows are written', async () => {
    await delegate('pa');
    await signInAs(redis, cookieJar, { username: 'pa-admin', name: 'Ada', partnerId: 'pa', role: 'admin' });
    const err = await createCustomerAction(form({ kycStatus: 'verified', reason: 'Checked passport in branch' })).catch((e: unknown) => e);
    expect(refOf(err)).toEqual({ partnerId: 'pa', phone: PHONE });
    expect(await cs().getCustomer('pa', PHONE)).toMatchObject({ kycStatus: 'verified', kycApprovedBy: 'Ada (pa-admin)' });
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['customer.create', 'kyc.manual_override.create']);
    expect(rows[1]).toMatchObject({
      partner_id: 'pa',
      actor: 'pa-admin',
      subject_id: auditSubjectId('pa', PHONE),
      meta: { previousStatus: null, newStatus: 'verified', reason: 'Checked passport in branch', source: 'manual', reviewerName: 'Ada (pa-admin)', actorScope: 'partner' },
    });
  });
  it('a failed audit insert leaves no customer row', async () => {
    await delegate('pa');
    await db.execute(sql.raw(`ALTER TABLE audit_events ADD CONSTRAINT test_no_override CHECK (action <> 'kyc.manual_override.create')`));
    await signInAs(redis, cookieJar, { partnerId: 'pa', role: 'admin' });
    expect(await createCustomerAction(form({ kycStatus: 'verified', reason: 'Checked passport in branch' }))).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(await customerCount()).toBe(0);
    expect(await audits()).toEqual([]);
  });
});
