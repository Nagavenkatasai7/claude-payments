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
  it('p2 B5: an enrolled agent WITHOUT canRevealPii gets one Show control per present field, as does an admin', async () => {
    await signInAs({ partnerId: PA, role: 'agent', username: 'ag' });
    await redis.set(staffMfaKeys.secret('ag'), JSON.stringify({ secretEnc: 'x', enrolledAt: 'y' }));
    expect((await detail(sealCustomerRef(PA, SHARED))).match(/>Show</g)).toHaveLength(4);
    await signInAs({ partnerId: PA, role: 'admin', username: 'adm' });
    await redis.set(staffMfaKeys.secret('adm'), JSON.stringify({ secretEnc: 'x', enrolledAt: 'y' }));
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html.match(/>Show</g)).toHaveLength(4);
    expect(html).not.toContain('data-reveal-hint');
  });
  it('a non-enrolled agent sees masked values, no Show control, and the hint to turn on two-step verification', async () => {
    await signInAs({ partnerId: PA, role: 'agent', username: 'ag-nomfa', permissions: { ...perms, canRevealPii: true } });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).not.toContain('>Show<');
    expect(html).toContain('data-reveal-hint');
    expect(html).toContain('href="/partner/security"');
  });
  it('nationality is masked and revealable when present', async () => {
    await createCustomerStore(db, createStore(redis, db)).saveCustomer(
      customer({ partnerId: PA, senderPhone: SHARED, fullName: A_NAME, dateOfBirth: DOB, residentialAddress: ADDR, nationality: 'IN' }),
    );
    await signInAs({ partnerId: PA, role: 'agent', username: 'ag2' });
    await redis.set(staffMfaKeys.secret('ag2'), JSON.stringify({ secretEnc: 'x', enrolledAt: 'y' }));
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('Nationality');
    expect(html.match(/>Show</g)).toHaveLength(5);
    expect(html).not.toMatch(/>IN</);
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

// UI redesign M3-12: the send-limits section. Every page viewer sees the EFFECTIVE limits (the
// same resolver a mint uses) with their source; only an admin gets the form, and never over a live
// SmartRemit override (the action refuses it too; the page does not offer it).
describe('/partner/customers/[ref]: send limits (M3-12)', () => {
  const plant = (v: Record<string, unknown>) =>
    createCustomerStore(db, createStore(redis, db)).setSendLimitOverride(PA, SHARED, v as never);
  const FORM = 'data-testid="partner-customer-limit-form"';

  it('an agent sees the effective limits (platform) but no form', async () => {
    await signInAs({ partnerId: PA, role: 'agent' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('Send limits');
    expect(html).toContain('$2,999.00');
    expect(html).toContain('Platform limit');
    expect(html).not.toContain(FORM);
  });
  it('an admin gets the form carrying the opaque ref only (never a phone or tenant field)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const ref = sealCustomerRef(PA, SHARED);
    const html = await detail(ref);
    expect(html).toContain(FORM);
    expect(html).toContain(`name="ref" value="${ref}"`);
    expect(html).not.toMatch(/name="(partnerId|partner|phone|setScope)"/);
    for (const v of ALL_PII) expect(html).not.toContain(v);
  });
  it('a partner-set override shows as "Set for this customer", clamped at read, and the admin may change it', async () => {
    await plant({ perTransferCapCents: 50_000, setScope: 'partner', setBy: 'adm' });
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('$500.00');
    expect(html).toContain('Set for this customer');
    expect(html).toContain(FORM);
  });
  it('a live SmartRemit override (legacy, no setScope) shows the notice and NO form, even to an admin', async () => {
    await plant({ perTransferCapCents: 500_000, setBy: 'root' });
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('$5,000.00');
    expect(html).toContain('SmartRemit has set this customer');
    expect(html).not.toContain(FORM);
    expect(html).not.toContain('root');
  });
  it('an EXPIRED SmartRemit override lapses: platform limits, and the admin gets the form', async () => {
    await plant({ perTransferCapCents: 500_000, setBy: 'root', setScope: 'platform', expiresAt: daysAgo(1) });
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).not.toContain('$5,000.00');
    expect(html).toContain(FORM);
  });
});

// Lost-features p2 B4: country, tier, totals, last activity and closed filters; phones stay masked.
describe('/partner/customers: list columns and filters (p2 B4)', () => {
  beforeEach(async () => {
    const { seedPartnerTransfer } = await import('./helpers-partner-app');
    await seedPartnerTransfer(db, { id: 'ta1', partnerId: PA, phone: SHARED, amountUsd: 120, status: 'delivered' });
    await seedPartnerTransfer(db, { id: 'ta2', partnerId: PA, phone: SHARED, amountUsd: 30, status: 'cancelled' });
    await seedPartnerTransfer(db, { id: 'tat', partnerId: PA, phone: SHARED, amountUsd: 900, status: 'delivered', environment: 'test' });
    await seedPartnerTransfer(db, { id: 'tb1', partnerId: PB, phone: SHARED, amountUsd: 7777, status: 'delivered' });
  });
  const rowOf = (html: string, last4: string) => {
    const m = html.match(new RegExp(`<tr[^>]*>(?:(?!</tr>).)*••••${last4}(?:(?!</tr>).)*</tr>`, 's'));
    return m?.[0] ?? '';
  };
  it('totals are this tenant’s live rows only (cancelled not counted; test rows and B’s never)', async () => {
    await signInAs({ partnerId: PA, role: 'agent' });
    const html = await list();
    const row = rowOf(html, '0000');
    expect(row).toContain('data-col="transfers">1<');
    expect(row).toContain('data-col="sent">$120.00<');
    expect(row).toContain('>US<');
    expect(html).not.toContain('7,777');
    expect(html).not.toContain('$900.00');
    expect(rowOf(html, '1111')).toContain('data-col="transfers">0<');
    for (const v of ALL_PII) expect(html).not.toContain(v);
  });
  it('the summary counts the tenant’s customers and those in their first days', async () => {
    await createCustomerStore(db, createStore(redis, db)).saveCustomer(
      customer({ partnerId: PA, senderPhone: '15553334444', kycStatus: 'pending', firstSeenAt: daysAgo(1), createdAt: daysAgo(1) }),
    );
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await list();
    expect(html).toMatch(/data-customers-summary="">3 customers · 1 in their first days/);
    expect(rowOf(html, '4444')).toContain('data-tier="T0"');
    expect(rowOf(html, '4444')).toContain('Day 2 of 3');
  });
  it('filters by KYC status, tier and last 4; junk filters are ignored', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    expect(refsIn(await list({ kyc: 'pending' })).map((r) => openCustomerRef(r)?.phone)).toEqual([ONLY_A]);
    expect(refsIn(await list({ last4: '0000' })).map((r) => openCustomerRef(r)?.phone)).toEqual([SHARED]);
    expect(refsIn(await list({ tier: 'Suspended' }))).toEqual([]);
    expect(await list({ tier: 'Suspended' })).toContain('No customers match these filters.');
    expect(refsIn(await list({ kyc: 'nope', last4: '12' }))).toHaveLength(2);
    // A filter on B's phone at A finds nothing of B.
    expect(refsIn(await list({ last4: '2222' }))).toEqual([]);
  });
  it('sorts by last activity', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const phones = refsIn(await list({ sort: 'lastActivity', dir: 'desc' })).map((r) => openCustomerRef(r)?.phone);
    expect(phones).toEqual([SHARED, ONLY_A]);
  });
});

// Lost-features p2 B7 (sending today) and A10 (the customer's transfers).
describe('/partner/customers/[ref]: sending today and transfers (p2 B7, A10)', () => {
  beforeEach(async () => {
    const { seedPartnerTransfer } = await import('./helpers-partner-app');
    await seedPartnerTransfer(db, { id: 'tx_a_1', partnerId: PA, phone: SHARED, amountUsd: 120, status: 'paid' });
    await seedPartnerTransfer(db, { id: 'tx_a_test', partnerId: PA, phone: SHARED, amountUsd: 900, status: 'paid', environment: 'test' });
    await seedPartnerTransfer(db, { id: 'tx_b_1', partnerId: PB, phone: SHARED, amountUsd: 777, status: 'paid' });
  });
  it('shows today’s spend against the cap from this tenant’s live rows only', async () => {
    await signInAs({ partnerId: PA, role: 'agent' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('data-today="used">$120.00<');
    expect(html).toContain('data-today="left">$2,879.00<');
    expect(html).not.toContain('data-today="day"');
  });
  it('a customer in the first days shows the day of the window', async () => {
    await createCustomerStore(db, createStore(redis, db)).saveCustomer(
      customer({ partnerId: PA, senderPhone: ONLY_A, kycStatus: 'pending', firstSeenAt: daysAgo(0.5) }),
    );
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await detail(sealCustomerRef(PA, ONLY_A));
    expect(html).toContain('data-today="day">Day 1 of 3<');
    expect(html).toContain('No live transfers yet.');
  });
  it('lists this tenant’s live transfers for the customer, masked; never B’s or test rows', async () => {
    await signInAs({ partnerId: PA, role: 'agent' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('data-customer-transfer="tx_a_1"');
    expect(html).toContain('href="/partner/transfers/tx_a_1"');
    expect(html).not.toContain('tx_b_1');
    expect(html).not.toContain('tx_a_test');
    expect(html).toContain('Testname S.');
    for (const v of ['Samplesurname', '000011112222', '919876543210']) expect(html).not.toContain(v);
  });
  it('pages older transfers by an opaque cursor (no phone in the link)', async () => {
    const { seedPartnerTransfer } = await import('./helpers-partner-app');
    for (let i = 0; i < 26; i++) {
      await seedPartnerTransfer(db, { id: `tx_p_${i}`, partnerId: PA, phone: SHARED, status: 'delivered', createdAt: daysAgo(2 + i / 100) });
    }
    await signInAs({ partnerId: PA, role: 'admin' });
    const ref = sealCustomerRef(PA, SHARED);
    const html = await detail(ref);
    const older = html.match(/href="([^"]*\?tx=[^"]*)"/)?.[1];
    expect(older).toBeTruthy();
    expect(older).not.toContain(SHARED.slice(-6));
    const tx = new URL(older!.replace(/&amp;/g, '&'), 'https://x').searchParams.get('tx')!;
    const page2 = renderToStaticMarkup(
      await CustomerDetailPage({ params: Promise.resolve({ ref }), searchParams: Promise.resolve({ tx }) }),
    );
    expect(page2).toContain('data-customer-transfer="tx_p_25"');
    expect(page2).not.toContain('data-customer-transfer="tx_a_1"');
  });
});

// Lost-features p2 B6: the profile rows that come back, masked; never the rejected reason or a
// screening flag; the PEP row only when the customer answered.
describe('/partner/customers/[ref]: profile (p2 B6)', () => {
  it('shows country, masked ID, declared PEP, source of funds, occupation and a masked reference; pii.view names them', async () => {
    await createCustomerStore(db, createStore(redis, db)).saveCustomer(
      customer({
        partnerId: PA,
        senderPhone: SHARED,
        fullName: A_NAME,
        govIdType: 'passport',
        govIdNumber: 'X9981234',
        pepDeclared: false,
        sourceOfFunds: 'savings',
        occupation: 'retired',
        kycProviderRef: 'inq_ABCDEFGH7777',
        kycInquiryId: 'inq_ABCDEFGH7777',
        kycRejectedReason: 'Matched list entry',
        watchlistHit: true,
        pepHit: true,
      }),
    );
    await signInAs({ partnerId: PA, role: 'agent', username: 'ag-prof' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('data-testid="partner-customer-profile"');
    expect(html).toContain('Passport');
    expect(html).toContain('••••1234');
    expect(html).toContain('Declared politically exposed');
    expect(html).toContain('Savings');
    expect(html).toContain('Retired');
    expect(html).toContain('****7777');
    for (const v of ['X998', 'ABCDEFGH', 'Matched list']) expect(html).not.toContain(v);
    expect(html).not.toMatch(/watchlist|pep hit/i);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.fields).toEqual(['full_name', 'gov_id_last4', 'pep_declared', 'source_of_funds', 'occupation']);
  });
  it('no PEP answer → no PEP row', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).not.toContain('Declared politically exposed');
  });
});

// Lost-features p2 A9: the KYC decision history (durable audit rows only).
describe('/partner/customers/[ref]: decision history (p2 A9)', () => {
  async function decision(partnerId: string, actor: string, action: string, meta: Record<string, unknown>) {
    const { createAuditRepo } = await import('@/db/repos/aux-repos');
    await createAuditRepo(db).record({ partnerId, actor, actorType: 'staff', action, subjectId: auditSubjectId(partnerId, SHARED), meta });
  }
  it('own decisions show who and why; SmartRemit’s show the outcome only; B’s rows for the same phone never show', async () => {
    await decision(PA, 'pa-adm', 'kyc.review.approve', { reason: 'Documents look right', actorScope: 'partner', newStatus: 'verified' });
    await decision(PA, 'owner-root', 'kyc.manual_override.reject', { reason: 'Watchlist entry match', actorScope: 'platform', newStatus: 'rejected' });
    await decision(PB, 'pb-adm', 'kyc.review.reject', { reason: 'Bravo private reason', actorScope: 'partner' });
    await signInAs({ partnerId: PA, role: 'agent', username: 'ag-trail' });
    const html = await detail(sealCustomerRef(PA, SHARED));
    expect(html).toContain('data-testid="partner-kyc-trail"');
    expect(html).toContain('Documents look right');
    expect(html).toContain('pa-adm');
    expect(html).toContain('data-trail="rejected"');
    expect(html).toContain('SmartRemit');
    for (const v of ['Watchlist entry', 'owner-root', 'Bravo private', 'pb-adm']) expect(html).not.toContain(v);
  });
  it('no decisions → the empty line', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    expect(await detail(sealCustomerRef(PA, SHARED))).toContain('No verification decisions yet.');
  });
});
