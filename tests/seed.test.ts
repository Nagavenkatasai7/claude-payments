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
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
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
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerStore } from '@/lib/partner-store';
import { verifyPassword } from '@/lib/password';

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  db = await freshDb();
  ps = createPartnerStore(db);
  for (const k of Object.keys(envOverrides)) delete envOverrides[k];
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
