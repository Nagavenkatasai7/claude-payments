import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerAuthStore } from '@/lib/customer-auth-store';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { base32Decode, totpAt } from '@/lib/totp';

/**
 * Program-Fix 49D — portal TOTP enrolment from /account/settings. Public POST
 * endpoints: both self-gate with requireCustomer and act only on the
 * SESSION's account; step 1 re-proves the current password under the login
 * reservations; step 2 turns MFA on only with a valid code, signs every other
 * session out and writes one audit row.
 */

const crypto = new EnvKeyProvider('0'.repeat(64));
const redis = fakeRedis();

const cookieJar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string) => cookieJar.set(name, value));
const cookieGet = vi.fn((name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSet, delete: vi.fn(), get: cookieGet }),
  headers: async () => ({ get: (_n: string) => null }),
}));
const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectMock(p) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: CustomerStore;
let authStore: ReturnType<typeof createCustomerAuthStore>;
let nowMs = Date.now();

vi.mock('@/db/client', async (orig) => ({ ...(await orig<object>()), getDb: () => db }));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: () => customerStore };
});
vi.mock('@/lib/customer-auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-auth-store')>('@/lib/customer-auth-store');
  return { ...actual, getCustomerAuthStore: () => authStore };
});
vi.mock('@/lib/customer-mfa', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-mfa')>('@/lib/customer-mfa');
  return { ...actual, getCustomerMfaStore: () => actual.createCustomerMfaStore(redis, customerStore, { now: () => nowMs }) };
});
vi.mock('@/lib/field-crypto', async () => {
  const actual = await vi.importActual<typeof import('@/lib/field-crypto')>('@/lib/field-crypto');
  return { ...actual, defaultProvider: () => crypto };
});

import {
  beginCustomerMfaEnrolmentAction,
  confirmCustomerMfaEnrolmentAction,
  type CustomerMfaEnrolState,
} from '@/app/account/settings/mfa-actions';
import { getCustomerMfaStore } from '@/lib/customer-mfa';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

const PHONE = '+1 (202) 555-0123';
const NORM = '12025550123';
const PASSWORD = 'correct horse battery';
const WHO = { partnerId: 'default', phone: NORM };
const INITIAL: CustomerMfaEnrolState = { ok: false };

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  cookieSet.mockClear();
  redirectMock.mockClear();
  nowMs = Date.now();
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  authStore = createCustomerAuthStore(redis, customerStore);
  await authStore.registerCustomer({ phone: PHONE, email: 'a@example.com', password: PASSWORD });
  await authStore.markPhoneVerified(NORM);
  cookieJar.set(CUSTOMER_SESSION_COOKIE, await authStore.createSession(NORM, 'default'));
});

async function auditRows() {
  const res = await db.execute(sql`SELECT action, actor_type, subject_id FROM audit_events WHERE action LIKE 'customer.mfa.%'`);
  return (res as unknown as { rows: Record<string, unknown>[] }).rows;
}

describe('portal MFA enrolment (Program-Fix 49D)', () => {
  it('both steps self-gate: no session ⇒ /account/login', async () => {
    cookieJar.clear();
    await expect(beginCustomerMfaEnrolmentAction(INITIAL, form({ currentPassword: PASSWORD }))).rejects.toThrow('REDIRECT:/account/login');
    await expect(confirmCustomerMfaEnrolmentAction(INITIAL, form({ code: '123456' }))).rejects.toThrow('REDIRECT:/account/login');
  });

  it('a wrong current password is refused and starts nothing', async () => {
    const r = await beginCustomerMfaEnrolmentAction(INITIAL, form({ currentPassword: 'nope nope nope' }));
    expect(r.ok).toBe(false);
    expect(r.secret).toBeUndefined();
    expect(await getCustomerMfaStore().isEnrolled(WHO)).toBe(false);
  });

  it('password reservations apply: after 10 attempts even the right password is refused', async () => {
    for (let i = 0; i < 10; i++) await beginCustomerMfaEnrolmentAction(INITIAL, form({ currentPassword: 'nope nope nope' }));
    const r = await beginCustomerMfaEnrolmentAction(INITIAL, form({ currentPassword: PASSWORD }));
    expect(r.ok).toBe(false);
    expect(r.secret).toBeUndefined();
  });

  it('begin → confirm with one code turns it on, signs other sessions out, re-mints this one, audits', async () => {
    const other = await authStore.createSession(NORM, 'default');
    const begun = await beginCustomerMfaEnrolmentAction(INITIAL, form({ currentPassword: PASSWORD }));
    expect(begun.ok).toBe(true);
    expect(begun.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(begun.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(await getCustomerMfaStore().isEnrolled(WHO)).toBe(false); // not until confirmed

    const bad = await confirmCustomerMfaEnrolmentAction(INITIAL, form({ code: '000000' }));
    expect(bad.ok).toBe(false);
    expect(await getCustomerMfaStore().isEnrolled(WHO)).toBe(false);

    const code = totpAt(base32Decode(begun.secret!), nowMs);
    const done = await confirmCustomerMfaEnrolmentAction(INITIAL, form({ code: code.slice(0, 3) + ' ' + code.slice(3) }));
    expect(done.ok).toBe(true);
    expect(await getCustomerMfaStore().isEnrolled(WHO)).toBe(true);
    expect(await authStore.getSessionIdentity(other)).toBeNull(); // other device signed out
    const mine = cookieSet.mock.calls.find((c) => c[0] === CUSTOMER_SESSION_COOKIE)?.[1];
    expect(mine && (await authStore.getSessionIdentity(mine))?.phone).toBe(NORM);
    const rows = await auditRows();
    expect(rows).toEqual([{ action: 'customer.mfa.enroll', actor_type: 'system', subject_id: expect.stringMatching(/^cust:[0-9a-f]{64}$/) }]);
    expect(JSON.stringify(rows)).not.toContain(begun.secret!);
  });

  it('begin is refused while already on', async () => {
    const begun = await beginCustomerMfaEnrolmentAction(INITIAL, form({ currentPassword: PASSWORD }));
    await confirmCustomerMfaEnrolmentAction(INITIAL, form({ code: totpAt(base32Decode(begun.secret!), nowMs) }));
    const again = await beginCustomerMfaEnrolmentAction(INITIAL, form({ currentPassword: PASSWORD }));
    expect(again.ok).toBe(false);
    expect(again.secret).toBeUndefined();
  });
});
