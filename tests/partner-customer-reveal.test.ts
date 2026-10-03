import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import type { Db } from '@/db/client';
import type { Customer, Staff } from '@/lib/types';

// UI redesign M3-11: revealCustomerFieldAction, the ONLY path from /partner to a decrypted
// customer value. Every refusal has the same shape as "missing" and writes nothing; a success
// writes exactly one pii.reveal row BEFORE the value is returned; an audit failure returns no value.
const redis = fakeRedis();
let db: Db;
const fail = { audit: false, redis: false };
const cookieJar = new Map<string, string>();
let host = 'smartremit.ai';
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host }),
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
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async () => {
  const actual = await vi.importActual<typeof import('@/lib/log')>('@/lib/log');
  return { ...actual, logWarn: logWarnSpy };
});
vi.mock('@/db/repos/aux-repos', async () => {
  const actual = await vi.importActual<typeof import('@/db/repos/aux-repos')>('@/db/repos/aux-repos');
  return {
    ...actual,
    createAuditRepo: (d: Parameters<typeof actual.createAuditRepo>[0]) => {
      const repo = actual.createAuditRepo(d);
      if (fail.audit) repo.record = async () => Promise.reject(new Error('audit down 15551230000'));
      return repo;
    },
  };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { staffMfaKeys } from '@/lib/staff-mfa-store';
import { auditSubjectId, sealCustomerRef } from '@/lib/customer-ref';
import { REVEAL_LIMIT, REVEAL_TENANT_LIMIT, revealThrottleKey, takeRevealBudget } from '@/lib/partner-reveal-throttle';
import { revealCustomerFieldAction } from '@/app/partner/(app)/customers/[ref]/actions';

const PA = 'ptn-alpha3';
const PB = 'ptn-bravo9';
const SHARED = '15551230000';
const ONLY_B = '15558882222';
const A_NAME = 'Ashaqz Ramanathan';
const B_NAME = 'Zubqx Quellen';
const DOB = '1987-03-14';
const ADDR = '42 Elmqz Street';
const NOT_FOUND = { error: 'That customer was not found.' };

const noPerms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
async function signInAs(o: Partial<Staff>, opts: { mfa?: boolean } = { mfa: true }): Promise<Staff> {
  const s: Staff = {
    username: 'u1',
    name: 'U',
    role: 'admin',
    permissions: noPerms,
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    ...o,
  };
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
  if (opts.mfa) await redis.set(staffMfaKeys.secret(s.username), JSON.stringify({ secretEnc: 'x', enrolledAt: 'y' }));
  return s;
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
async function reveals() {
  const res = await db.execute(sql`SELECT partner_id, actor, subject_id, meta FROM audit_events WHERE action = 'pii.reveal'`);
  return (res as unknown as { rows: Array<{ partner_id: string; actor: string; subject_id: string; meta: Record<string, unknown> }> }).rows;
}
const reveal = (ref: string, field: string) => revealCustomerFieldAction(ref, field as never);

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  logWarnSpy.mockClear();
  fail.audit = false;
  fail.redis = false;
  host = 'smartremit.ai';
  db = await freshDb();
  await seedPartner(db, PA, 'Alpha Remit');
  await seedPartner(db, PB, 'Bravo Remit');
  const cs = createCustomerStore(db, createStore(redis, db));
  await cs.saveCustomer(customer({ partnerId: PA, fullName: A_NAME, dateOfBirth: DOB, residentialAddress: ADDR }));
  await cs.saveCustomer(customer({ partnerId: PB, fullName: B_NAME, dateOfBirth: '1990-01-01' }));
  await cs.saveCustomer(customer({ partnerId: PB, senderPhone: ONLY_B, fullName: B_NAME }));
});

describe('revealCustomerFieldAction: the gate', () => {
  it('a partner-site host is refused before anything else', async () => {
    await signInAs({ partnerId: PA });
    host = 'acme.smartremit.ai';
    await expect(reveal(sealCustomerRef(PA, SHARED), 'full_name')).rejects.toThrow('NOT_FOUND');
    expect(await reveals()).toHaveLength(0);
  });
  it('anonymous → /login; platform → /admin-dashboard; support → /partner; finance refused; no audit', async () => {
    const ref = sealCustomerRef(PA, SHARED);
    await expect(reveal(ref, 'full_name')).rejects.toThrow('REDIRECT:/login');
    await signInAs({ partnerId: undefined });
    await expect(reveal(ref, 'full_name')).rejects.toThrow('REDIRECT:/admin-dashboard');
    await signInAs({ partnerId: PA, role: 'support', permissions: { ...noPerms, canRevealPii: true } });
    await expect(reveal(ref, 'full_name')).rejects.toThrow(/^REDIRECT:\/partner$/);
    await signInAs({ partnerId: PA, role: 'finance' as Staff['role'], permissions: { ...noPerms, canRevealPii: true } });
    await expect(reveal(ref, 'full_name')).rejects.toThrow(/^REDIRECT:\/(partner|login)$/);
    expect(await reveals()).toHaveLength(0);
  });
});

describe('revealCustomerFieldAction: refusals (same shape as missing, no audit)', () => {
  it('a field outside the allowlist (email, __proto__, a non-string)', async () => {
    await signInAs({ partnerId: PA });
    const ref = sealCustomerRef(PA, SHARED);
    for (const f of ['email', '__proto__', 'constructor', 'govIdNumber', 'payout_destination', 'recipient_name', '']) {
      expect(await reveal(ref, f), f).toEqual(NOT_FOUND);
    }
    expect(await revealCustomerFieldAction(ref, { toString: () => 'full_name' } as never)).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
  it('staff who have not set up two-step verification (admin or agent, with or without canRevealPii)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' }, { mfa: false });
    expect(await reveal(sealCustomerRef(PA, SHARED), 'full_name')).toEqual(NOT_FOUND);
    await signInAs({ partnerId: PA, role: 'agent', username: 'ag-nomfa', permissions: { ...noPerms, canRevealPii: true } }, { mfa: false });
    expect(await reveal(sealCustomerRef(PA, SHARED), 'full_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
  it("another tenant's customer, even for the SAME phone; junk and non-string refs", async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    for (const ref of [sealCustomerRef(PB, SHARED), sealCustomerRef(PB, ONLY_B), sealCustomerRef(PA, ONLY_B), SHARED, 'junk', '']) {
      expect(await reveal(ref, 'full_name'), ref).toEqual(NOT_FOUND);
    }
    expect(await revealCustomerFieldAction(42 as never, 'full_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
  it('a field the customer does not have', async () => {
    const cs = createCustomerStore(db, createStore(redis, db));
    await cs.saveCustomer(customer({ partnerId: PA, senderPhone: '15550001234' }));
    await signInAs({ partnerId: PA, role: 'admin' });
    expect(await reveal(sealCustomerRef(PA, '15550001234'), 'full_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
});

describe('revealCustomerFieldAction: success', () => {
  // Lost-features p2 B5 (review BL-1, the one reveal rule): identity fields need admin or agent with
  // two-step verification, never canRevealPii (the old dashboard showed them to agents in clear).
  it('an enrolled agent WITHOUT canRevealPii may reveal identity: value and one pii.reveal', async () => {
    await signInAs({ partnerId: PA, role: 'agent', username: 'agent-noflag' });
    expect(await reveal(sealCustomerRef(PA, SHARED), 'full_name')).toEqual({ value: A_NAME });
    const rows = await reveals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'agent-noflag', meta: { field: 'full_name', actorScope: 'partner' } });
  });
  it('nationality is revealable: the ISO code, field=nationality', async () => {
    const cs = createCustomerStore(db, createStore(redis, db));
    await cs.saveCustomer(customer({ partnerId: PA, fullName: A_NAME, nationality: 'IN' }));
    await signInAs({ partnerId: PA, role: 'agent', username: 'agent-nat' });
    expect(await reveal(sealCustomerRef(PA, SHARED), 'nationality')).toEqual({ value: 'IN' });
    expect((await reveals()).map((r) => r.meta.field)).toEqual(['nationality']);
  });
  it('returns the value and writes exactly ONE pii.reveal row (field name, partner-marked, keyed subject)', async () => {
    await signInAs({ partnerId: PA, role: 'agent', username: 'agent-a', permissions: { ...noPerms, canRevealPii: true } });
    const ref = sealCustomerRef(PA, SHARED);
    expect(await reveal(ref, 'full_name')).toEqual({ value: A_NAME });
    const rows = await reveals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: PA, actor: 'agent-a', subject_id: auditSubjectId(PA, SHARED) });
    expect(rows[0].meta).toEqual({ field: 'full_name', actorScope: 'partner' });
    expect(JSON.stringify(rows[0])).not.toMatch(/Ashaqz|15551230000/);
  });
  it('each allowlisted field returns its own value (PA row, never PB for the same phone)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const ref = sealCustomerRef(PA, SHARED);
    expect(await reveal(ref, 'phone')).toEqual({ value: `+${SHARED}` });
    expect(await reveal(ref, 'date_of_birth')).toEqual({ value: DOB });
    expect(await reveal(ref, 'residential_address')).toEqual({ value: ADDR });
    expect((await reveals()).map((r) => r.meta.field)).toEqual(['phone', 'date_of_birth', 'residential_address']);
  });
  it('an audit insert failure → an error and NO value; nothing PII in the log', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    fail.audit = true;
    const r = await reveal(sealCustomerRef(PA, SHARED), 'full_name');
    expect(r).toEqual(NOT_FOUND);
    expect(JSON.stringify(r)).not.toContain('Ashaqz');
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toMatch(/Ashaqz|15551230000|1987/);
  });
});

describe('revealCustomerFieldAction: rate limit (fails closed)', () => {
  it('allows REVEAL_LIMIT reveals per window per staff member, then refuses without an audit row', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    const ref = sealCustomerRef(PA, SHARED);
    for (let i = 0; i < REVEAL_LIMIT; i++) expect(await reveal(ref, 'phone')).toEqual({ value: `+${SHARED}` });
    expect(await reveal(ref, 'phone')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(REVEAL_LIMIT);
  });
  it('a Redis failure refuses the reveal (no value, no audit)', async () => {
    await signInAs({ partnerId: PA, role: 'admin' });
    fail.redis = true;
    expect(await reveal(sealCustomerRef(PA, SHARED), 'full_name')).toEqual(NOT_FOUND);
    expect(await reveals()).toHaveLength(0);
  });
});

describe('partner-reveal-throttle', () => {
  it('keys per (tenant, staff member, window) and never carries a phone', () => {
    const k = revealThrottleKey(PA, 'alice', 0);
    expect(k).toContain(PA);
    expect(k).toContain('alice');
    expect(revealThrottleKey(PB, 'alice', 0)).not.toBe(k);
    expect(revealThrottleKey(PA, 'bob', 0)).not.toBe(k);
  });
  it('a tenant-wide ceiling caps many staff members together (extra accounts do not multiply the budget)', async () => {
    const r = fakeRedis();
    let allowed = 0;
    for (let u = 0; allowed < REVEAL_TENANT_LIMIT + 5 && u < 100; u++) {
      for (let i = 0; i < REVEAL_LIMIT; i++) if (await takeRevealBudget(r, PA, `staff${u}`, 1_000)) allowed++;
    }
    expect(allowed).toBe(REVEAL_TENANT_LIMIT);
    expect(REVEAL_TENANT_LIMIT).toBeGreaterThan(REVEAL_LIMIT);
    expect(await takeRevealBudget(r, PB, 'staff0', 1_000)).toBe(true);
  });
  it('one tenant spending its budget never throttles another', async () => {
    const r = fakeRedis();
    for (let i = 0; i < REVEAL_LIMIT; i++) expect(await takeRevealBudget(r, PA, 'alice', 1_000)).toBe(true);
    expect(await takeRevealBudget(r, PA, 'alice', 1_000)).toBe(false);
    expect(await takeRevealBudget(r, PB, 'alice', 1_000)).toBe(true);
    expect(await takeRevealBudget(r, PA, 'bob', 1_000)).toBe(true);
  });
});
