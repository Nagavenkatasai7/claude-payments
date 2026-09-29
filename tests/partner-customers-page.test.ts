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

// UI redesign M3-11: /partner/customers (list) and /partner/customers/[ref] (detail). The M3-1
// harness: the real auth store on a fake Redis, real stores on PGlite; every cached store getter
// is rebuilt on the current db.
const redis = fakeRedis();
let db: Db;
let pgPartnerStore: PartnerStore;
const fail = { audit: false };
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
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
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
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
import { auditSubjectId, openCustomerRef, sealCustomerRef } from '@/lib/customer-ref';
import { staffMfaKeys } from '@/lib/staff-mfa-store';
import CustomersPage from '@/app/partner/(app)/customers/page';
import CustomerDetailPage from '@/app/partner/(app)/customers/[ref]/page';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const SHARED = '15551230000'; // the SAME phone is a customer at both partners
const ONLY_A = '15557771111';
const ONLY_B = '15558882222';
const A_NAME = 'Ashaqz Ramanathan';
const B_NAME = 'Zubqx Quellen';
const DOB = '1987-03-14';
const ADDR = '42 Elmqz Street';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s: Staff = {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: perms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
function customer(over: Partial<Customer>): Customer {
  return {
    senderPhone: SHARED,
    firstSeenAt: daysAgo(10),
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: PA,
    createdAt: daysAgo(10),
    updatedAt: daysAgo(1),
    ...over,
  } as Customer;
}

const list = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await CustomersPage({ searchParams: Promise.resolve(sp) }));
const detail = async (ref: string) => renderToStaticMarkup(await CustomerDetailPage({ params: Promise.resolve({ ref }) }));

async function auditRows(action = 'pii.view') {
  const res = await db.execute(sql`SELECT partner_id, actor, subject_id, meta FROM audit_events WHERE action = ${action}`);
  return (res as unknown as { rows: Array<{ partner_id: string; actor: string; subject_id: string; meta: Record<string, unknown> }> }).rows;
}
const refsIn = (html: string) =>
  [...html.matchAll(/href="\/partner\/customers\/([^"?]+)"/g)].map((m) => decodeURIComponent(m[1]));

const ALL_PII = [SHARED, ONLY_A, ONLY_B, A_NAME, B_NAME, 'Ashaqz', 'Ramanathan', 'Zubqx', 'Quellen', DOB, ADDR, 'Elmqz'];

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  fail.audit = false;
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, PA, 'Alpha Remit');
  await seedPartner(db, PB, 'Bravo Remit');
  const cs = createCustomerStore(db, createStore(redis, db));
  await cs.saveCustomer(customer({ partnerId: PA, senderPhone: SHARED, fullName: A_NAME, dateOfBirth: DOB, residentialAddress: ADDR }));
  await cs.saveCustomer(customer({ partnerId: PA, senderPhone: ONLY_A, fullName: A_NAME, kycStatus: 'pending', createdAt: daysAgo(2) }));
  await cs.saveCustomer(
    customer({
      partnerId: PB,
      senderPhone: SHARED,
      fullName: B_NAME,
      kycStatus: 'rejected',
      kycRejectedReason: 'Matched list entry',
      watchlistHit: true,
    }),
  );
  await cs.saveCustomer(customer({ partnerId: PB, senderPhone: ONLY_B, fullName: B_NAME }));
});

describe('/partner/customers: gate', () => {
  it('anonymous → /login; platform staff → /admin-dashboard', async () => {
    await expect(list()).rejects.toThrow('REDIRECT:/login');
    await expect(detail(sealCustomerRef(PA, SHARED))).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(list()).rejects.toThrow('REDIRECT:/admin-dashboard');
    await expect(detail(sealCustomerRef(PA, SHARED))).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('support → /partner on both pages, and no pii.view row', async () => {
    await signInAs({ partnerId: PA, role: 'support' });
    await expect(list()).rejects.toThrow(/^REDIRECT:\/partner$/);
    await expect(detail(sealCustomerRef(PA, SHARED))).rejects.toThrow(/^REDIRECT:\/partner$/);
    expect(await auditRows()).toHaveLength(0);
  });
  it('finance is refused on both pages (→ /partner once the role exists; → /login while unknown), no pii.view', async () => {
    await signInAs({ partnerId: PA, role: 'finance' as Staff['role'] });
    await expect(list()).rejects.toThrow(/^REDIRECT:\/(partner|login)$/);
    await expect(detail(sealCustomerRef(PA, SHARED))).rejects.toThrow(/^REDIRECT:\/(partner|login)$/);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('/partner/customers: list', () => {
  it("shows the SESSION tenant's customers only, masked, with opaque refs to its own rows", async () => {
    await signInAs({ partnerId: PA, role: 'agent' });
    const html = await list();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const refs = refsIn(html);
    expect(refs).toHaveLength(2);
    const opened = refs.map((r) => openCustomerRef(r));
    expect(opened.every((o) => o?.partnerId === PA)).toBe(true);
    expect(opened.map((o) => o?.phone).sort()).toEqual([SHARED, ONLY_A].sort());
    expect(html).toContain('••••0000');
    expect(html).toContain('••••1111');
    expect(html).not.toContain('••••2222');
    for (const v of ALL_PII) expect(html).not.toContain(v);
    expect(html).toContain('Verified');
    expect(html).toContain('Pending');
  });
  it('writes no audit row (no identity is rendered)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    await list();
    expect(await auditRows()).toHaveLength(0);
  });
  it('ignores any tenant in the query (partnerId / partner params)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await list({ partnerId: PB, partner: PB });
    expect(refsIn(html).every((r) => openCustomerRef(r)?.partnerId === PA)).toBe(true);
    expect(html).not.toContain('••••2222');
  });
  it('an empty tenant shows the empty state', async () => {
    await seedPartner(db, 'ptn-empty1', 'Empty');
    await signInAs({ partnerId: 'ptn-empty1', role: 'admin' });
    const html = await list();
    expect(html).toContain('No customers yet');
  });
  it('pages 50 at a time', async () => {
    const cs = createCustomerStore(db, createStore(redis, db));
    for (let i = 0; i < 55; i++) {
      await cs.saveCustomer(customer({ partnerId: PA, senderPhone: `1555600${String(i).padStart(4, '0')}`, createdAt: daysAgo(3) }));
    }
    await signInAs({ partnerId: PA, role: 'admin' });
    expect(refsIn(await list())).toHaveLength(50);
    expect(refsIn(await list({ page: '2' }))).toHaveLength(7);
  });
});

describe('/partner/customers/[ref]: detail', () => {
  it("a ref sealed for another tenant → NOT_FOUND and NO pii.view (even for the same phone)", async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    await expect(detail(sealCustomerRef(PB, ONLY_B))).rejects.toThrow('NOT_FOUND');
    await expect(detail(sealCustomerRef(PB, SHARED))).rejects.toThrow('NOT_FOUND');
    expect(await auditRows()).toHaveLength(0);
  });
  it('junk, a raw phone, or a ref for a phone the tenant does not have → NOT_FOUND, no audit', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    for (const ref of ['junk', SHARED, `v2.k0.${'A'.repeat(20)}.B.C.D`, sealCustomerRef(PA, ONLY_B)]) {
      await expect(detail(ref), ref).rejects.toThrow('NOT_FOUND');
    }
    expect(await auditRows()).toHaveLength(0);
  });
  it("the tenant's own customer → exactly ONE pii.view (keyed subject, partner-marked); the HTML is masked", async () => {
    await signInAs({ partnerId: PA, role: 'agent', username: 'agent-a' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: PA, actor: 'agent-a', subject_id: auditSubjectId(PA, SHARED) });
    expect(rows[0].meta).toMatchObject({ actorScope: 'partner' });
    expect(JSON.stringify(rows[0])).not.toContain('Ashaqz');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    for (const v of ALL_PII) expect(html).not.toContain(v);
    expect(html).toContain('••••0000');
    expect(html).toContain('A. R.');
    // The same phone at PB resolves to PA's row only: PB's name, status and screening never show.
    expect(html).not.toContain('Z. Q.');
    expect(html).not.toMatch(/watchlist|sanction|pep hit|Matched list/i);
    expect(html).toContain('Verified');
  });
  it('an agent without canRevealPii sees masked values and no Show control; admin gets one per present field', async () => {
    await signInAs({ partnerId: PA, role: 'agent' });
    expect(await detail(sealCustomerRef(PA, SHARED))).not.toContain('>Show<');
    await signInAs({ partnerId: PA, role: 'admin', username: 'adm' });
    await redis.set(staffMfaKeys.secret('adm'), JSON.stringify({ secretEnc: 'x', enrolledAt: 'y' }));
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html.match(/>Show</g)).toHaveLength(4);
  });
  it('an admin without two-step verification sees no Show control (the reveal would be refused)', async () => {
    await signInAs({ partnerId: PA, role: 'admin', username: 'adm-nomfa' });
    expect(await detail(sealCustomerRef(PA, SHARED))).not.toContain('>Show<');
  });
  it('if the pii.view audit write fails, the page fails (no identity without a record)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    fail.audit = true;
    await expect(detail(sealCustomerRef(PA, SHARED))).rejects.toThrow('audit down');
  });
});
