import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

const redis = fakeRedis();
// Partner store is Postgres-backed now; rebuilt from a fresh PGlite per test.
// The vi.mock factory closes over the let-variable (assigned in beforeEach).
let db: Db;
let ps: import('@/lib/partner-store').PartnerStore;
const envOverrides: Record<string, string> = {};
vi.mock('@/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, prop: string) {
      // MISSING mirrors env.ts `required()`: a missing SEED_ADMIN_* var throws on read.
      if (prop === 'seedAdminUsername') {
        if (envOverrides.MISSING) throw new Error('Missing required environment variable: SEED_ADMIN_USERNAME');
        return envOverrides.SEED_ADMIN_USERNAME ?? 'admin';
      }
      if (prop === 'seedAdminPassword') {
        if (envOverrides.MISSING) throw new Error('Missing required environment variable: SEED_ADMIN_PASSWORD');
        return envOverrides.SEED_ADMIN_PASSWORD ?? 'pw';
      }
      if (prop === 'seedPartnerUsername') return envOverrides.SEED_PARTNER_USERNAME ?? '';
      if (prop === 'seedPartnerPassword') return envOverrides.SEED_PARTNER_PASSWORD ?? '';
      if (prop === 'seedPartnerId') return envOverrides.SEED_PARTNER_ID ?? '';
      return '';
    },
  }),
}));
// Program-Fix 45 P5: the store the app uses carries the Postgres staff ledger
// (the fresh PGlite db). `ledgerOverride` swaps in a failing ledger per test.
let ledgerOverride: import('@/lib/auth-store').StaffLedger | null = null;
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  const { createStaffRepo } = await vi.importActual<typeof import('@/db/repos/staff-repo')>('@/db/repos/staff-repo');
  return {
    ...actual,
    getAuthStore: () => actual.createAuthStore(redis, { ledger: () => ledgerOverride ?? createStaffRepo(db) }),
  };
});
// Program-Fix 17b: login() asks whether the account enrolled in TOTP.
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => ps };
});

// The login-level case below runs the real login action on in-memory fakes.
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
    throw new Error(`REDIRECT:${p}`);
  },
}));
vi.mock('@/lib/staff-login-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-login-guard')>('@/lib/staff-login-guard');
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis) };
});
vi.mock('@/lib/staff-auth-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-auth-audit')>('@/lib/staff-auth-audit');
  return { ...actual, getStaffAuthAudit: () => actual.createStaffAuthAudit({ record: async () => {}, ipKey: () => Buffer.alloc(32, 1) }) };
});
const logErrorMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async () => {
  const actual = await vi.importActual<typeof import('@/lib/log')>('@/lib/log');
  return { ...actual, logError: logErrorMock };
});

import { ensureSeedAdmin } from '@/lib/seed';
import { login } from '@/app/login/actions';
import { SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '@/lib/session-cookie';
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerStore } from '@/lib/partner-store';
import { verifyPassword } from '@/lib/password';
import { createStaffRepo } from '@/db/repos/staff-repo';
import { getAuthStore } from '@/lib/auth-store';

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  ps = createPartnerStore(db);
  for (const k of Object.keys(envOverrides)) delete envOverrides[k];
  ledgerOverride = null;
});
afterEach(() => vi.clearAllMocks());

describe('ensureSeedAdmin', () => {
  it('creates an admin from env when no staff exist', async () => {
    envOverrides.SEED_ADMIN_PASSWORD = 'admin-test-pw';
    await ensureSeedAdmin();
    const admin = await createAuthStore(redis).getStaff('admin');
    expect(admin?.role).toBe('admin');
    expect(await verifyPassword('admin-test-pw', admin!.passwordHash)).toBe(true);
  });

  it('does nothing when staff already exist', async () => {
    await ensureSeedAdmin();
    await ensureSeedAdmin();
    expect(await createAuthStore(redis).listStaff()).toHaveLength(1);
  });

  it('seeds the platform admin when no staff exist', async () => {
    await ensureSeedAdmin();
    const got = await createAuthStore(redis).getStaff('admin');
    expect(got?.role).toBe('admin');
    expect(got?.partnerId).toBeUndefined();
  });

  it('also seeds a partner staff when partner-seed env vars are set', async () => {
    envOverrides.SEED_PARTNER_USERNAME = 'p1';
    envOverrides.SEED_PARTNER_PASSWORD = 'hunter2';
    envOverrides.SEED_PARTNER_ID = 'acme';
    await ensureSeedAdmin();
    const got = await createAuthStore(redis).getStaff('p1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
  });

  it('is idempotent on the partner-staff branch', async () => {
    envOverrides.SEED_PARTNER_USERNAME = 'p1';
    envOverrides.SEED_PARTNER_PASSWORD = 'hunter2';
    envOverrides.SEED_PARTNER_ID = 'acme';
    await ensureSeedAdmin();
    await ensureSeedAdmin();          // second call no-ops
    const all = await createAuthStore(redis).listStaff();
    expect(all.filter((s) => s.username === 'p1')).toHaveLength(1);
  });
});

// Program-Fix 45 P1 (crypto-14, seed half): with no staff at all and the seed
// variables unset, sign-in must answer with the ordinary generic error and log
// the misconfiguration, never crash the login action.
describe('ensureSeedAdmin with SEED_ADMIN_* unset (Program-Fix 45 P1)', () => {
  it('does not throw, seeds nothing, and logs an error', async () => {
    envOverrides.MISSING = '1';
    await expect(ensureSeedAdmin()).resolves.toBeUndefined();
    expect(await createAuthStore(redis).listStaff()).toHaveLength(0);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(logErrorMock.mock.calls[0]);
    expect(text).toMatch(/SEED_ADMIN/);
  });

  it('the login action returns the generic error instead of throwing', async () => {
    envOverrides.MISSING = '1';
    const fd = new FormData();
    fd.set('username', 'someone');
    fd.set('password', 'whatever-password');
    await expect(login(null, fd)).resolves.toBe('Invalid username or password.');
    expect(cookieJar.size).toBe(0);
  });
});

// Program-Fix 45 P1: a fresh sign-in replaces the browser's session. The
// sessions behind the cookies it presented (new or legacy) are revoked, not
// just overwritten client-side.
describe('login revokes the sessions behind the presented cookies (Program-Fix 45 P1)', () => {
  it('both the __Host- and the legacy token stop resolving; the new cookie is set', async () => {
    await ensureSeedAdmin(); // admin / 'pw' from the env mock
    const store = createAuthStore(redis);
    const oldNew = await store.createSession('admin');
    const oldLegacy = await store.createSession('admin');
    cookieJar.set(SESSION_COOKIE, oldNew);
    cookieJar.set(LEGACY_SESSION_COOKIE, oldLegacy);
    const fd = new FormData();
    fd.set('username', 'admin');
    fd.set('password', 'pw');
    await expect(login(null, fd)).rejects.toThrow('REDIRECT:/admin-dashboard');
    expect(await store.getSessionUser(oldNew)).toBeNull();
    expect(await store.getSessionUser(oldLegacy)).toBeNull();
    const fresh = cookieJar.get(SESSION_COOKIE);
    expect(fresh && fresh !== oldNew).toBe(true);
    expect(await store.getSessionUser(fresh!)).toBe('admin');
    expect(cookieJar.has(LEGACY_SESSION_COOKIE)).toBe(false);
  });
});

// Program-Fix 45 P5 (crypto-03): the seed admin across the staff ledger. Owner
// rule: nothing may lock out the seed admin.
describe('seed admin and the staff ledger (Program-Fix 45 P5)', () => {
  function signIn(username: string, password: string) {
    const fd = new FormData();
    fd.set('username', username);
    fd.set('password', password);
    return login(null, fd);
  }

  it('the seed lands in both stores', async () => {
    await ensureSeedAdmin();
    const row = await createStaffRepo(db).get('admin');
    expect(row?.role).toBe('admin');
    expect(row?.partnerId).toBeUndefined();
    expect(redis.dump.has('staff:admin')).toBe(true);
  });

  it('a ledger outage never stops the seed: the Redis record lands and the seed admin signs in', async () => {
    const failingLedger = new Proxy(createStaffRepo(db), {
      get: () => async () => {
        throw new Error('ledger down');
      },
    });
    ledgerOverride = failingLedger;
    await ensureSeedAdmin();
    expect(redis.dump.has('staff:admin')).toBe(true);
    await expect(signIn('admin', 'pw')).rejects.toThrow('REDIRECT:/admin-dashboard');
  });

  it('a stale suspended/demoted row never locks the seed admin out', async () => {
    await ensureSeedAdmin();
    const repo = createStaffRepo(db);
    const row = (await repo.get('admin'))!;
    await repo.upsert({ ...row, status: 'suspended', role: 'support' });
    await expect(signIn('admin', 'pw')).rejects.toThrow('REDIRECT:/admin-dashboard');
  });

  it('a suspended row DOES stop any other member (most restrictive)', async () => {
    await ensureSeedAdmin();
    const store = getAuthStore();
    const admin = (await store.getStaff('admin'))!;
    await store.saveStaff({ ...admin, username: 'teammate', name: 'Teammate' });
    const repo = createStaffRepo(db);
    await repo.upsert({ ...(await repo.get('teammate'))!, status: 'suspended' });
    await expect(signIn('teammate', 'pw')).resolves.toBe('Account unavailable. Contact SmartRemit support.');
    expect(cookieJar.size).toBe(0);
  });

  it('a Redis flush with rows left behind re-seeds the seed admin, who signs in', async () => {
    await ensureSeedAdmin();
    redis.dump.clear();
    await redis.srem('staff:index', 'admin');
    await ensureSeedAdmin();
    await expect(signIn('admin', 'pw')).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
});
