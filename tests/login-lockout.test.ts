/**
 * Program-Fix 17a — staff sign-in throttling, lockout and the auth.* trail.
 *
 * The seed admin must be IMPOSSIBLE to lock out by anything this PR ships:
 * no outer ring, no per-IP bucket, no all-IP username bucket — only the
 * per-(username, IP) bucket applies. Control cases prove every exemption is
 * real (a non-seed account IS refused by the same sequence).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { AuditEvent } from '@/db/repos/aux-repos';

const redis = fakeRedis(); // staff records, sessions, guard buckets
const ringRedis = fakeRedis(); // the outer ring's private limiter client
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
let currentIp = '198.51.100.1';
const T0 = Date.UTC(2026, 8, 23, 10, 1, 0); // 1 min into an hour bucket
let clock = T0;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ 'x-forwarded-for': currentIp }),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
// Program-Fix 17b: login() asks whether the account enrolled in TOTP.
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/seed', () => ({ ensureSeedAdmin: async () => {} }));
vi.mock('@/lib/staff-login-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-login-guard')>('@/lib/staff-login-guard');
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis, { now: () => clock }) };
});
// The real outer ring, on a fake client and the test clock.
vi.mock('@/lib/ip-rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ip-rate-limit')>('@/lib/ip-rate-limit');
  return {
    ...actual,
    isIpRateLimited: (h: Headers, scope: string, limit: number, windowSec?: number) =>
      actual.isIpRateLimited(h, scope, limit, windowSec, { redis: ringRedis, now: () => clock }),
  };
});
const audited: AuditEvent[] = [];
type AuditRecord = (e: AuditEvent) => Promise<void>;
let auditRecord: AuditRecord = async (e) => {
  audited.push(e);
};
let auditTimeoutMs = 1500;
vi.mock('@/lib/staff-auth-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-auth-audit')>('@/lib/staff-auth-audit');
  return {
    ...actual,
    getStaffAuthAudit: () =>
      actual.createStaffAuthAudit({
        record: (e) => auditRecord(e),
        ipKey: () => Buffer.alloc(32, 3),
        timeoutMs: auditTimeoutMs,
        warn: () => {},
      }),
  };
});

import { login, logout } from '@/app/login/actions';
import { getAuthStore } from '@/lib/auth-store';
import { hashPassword } from '@/lib/password';
import { staffLoginKeys, STAFF_IP_CAP, STAFF_U_CAP } from '@/lib/staff-login-guard';
import type { Staff } from '@/lib/types';

const THROTTLED = 'Too many attempts. Try again later.';
const GENERIC = 'Invalid username or password.';
const SEED = 'admin'; // tests/setup.ts: SEED_ADMIN_USERNAME ||= 'admin'
let GOOD_HASH: string;

function row(over: Partial<Staff>): Staff {
  return {
    username: 'ops',
    name: 'Ops',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: GOOD_HASH,
    createdAt: '2026-05-27T00:00:00Z',
    ...over,
  };
}

function form(username: string, password: string): FormData {
  const fd = new FormData();
  fd.set('username', username);
  fd.set('password', password);
  return fd;
}

async function attempt(username: string, password: string): Promise<string> {
  cookieJar.clear();
  try {
    return (await login(null, form(username, password))) ?? 'null';
  } catch (e) {
    return (e as Error).message; // 'REDIRECT:/admin-dashboard' on success
  }
}

const OK = 'REDIRECT:/admin-dashboard';
const ringKey = (ip: string) => `iprl|staff-login|${ip}|${Math.floor(clock / 60_000)}`;

beforeEach(async () => {
  redis.dump.clear();
  ringRedis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  audited.length = 0;
  auditRecord = async (e) => {
    audited.push(e);
  };
  auditTimeoutMs = 1500;
  clock = T0;
  currentIp = '198.51.100.1';
  GOOD_HASH ??= await hashPassword('correct-password');
  pgPartnerStore = createPartnerStore(await freshDb());
  await getAuthStore().saveStaff(row({ username: SEED, name: 'Main Admin' }));
  await getAuthStore().saveStaff(row({ username: 'ops' }));
});

describe('staff login lockout (Program-Fix 17a)', { retry: 0 }, () => {
  it("50 failed logins as other users from the admin's IP → seed admin still logs in", async () => {
    currentIp = '198.51.100.7';
    // 50 failures across usernames, spread over ring windows so every one of
    // them reaches the per-IP bucket …
    for (let i = 0; i < STAFF_IP_CAP; i++) {
      if (i % 10 === 0) clock += 61_000;
      expect(await attempt(`someone${i}`, 'wrong')).toBe(GENERIC);
    }
    // … then a burst inside ONE ring window that trips the outer ring too.
    for (let i = 0; i < 25; i++) await attempt(`burst${i}`, 'wrong');
    expect(Number(ringRedis.dump.get(ringKey(currentIp)))).toBeGreaterThan(20);
    expect(Number(redis.dump.get(staffLoginKeys.ip(currentIp, clock)))).toBeGreaterThanOrEqual(STAFF_IP_CAP);

    // Control: a NON-seed platform admin from the same IP is refused …
    expect(await attempt('ops', 'correct-password')).toBe(THROTTLED);
    // … the seed admin is not.
    expect(await attempt(SEED, 'correct-password')).toBe(OK);
    expect(cookieJar.size).toBe(1);
    // Control for the per-IP bucket alone (next ring window): still refused for ops.
    clock += 61_000;
    expect(await attempt('ops', 'correct-password')).toBe(THROTTLED);
    expect(await attempt(SEED, 'correct-password')).toBe(OK);
  });

  it('30 failures from other IPs → seed admin logs in from a fresh IP (control: ops is refused at 31)', async () => {
    for (let i = 0; i <= STAFF_U_CAP; i++) {
      currentIp = `203.0.113.${i}`;
      expect(await attempt(SEED, 'wrong')).toBe(GENERIC);
    }
    currentIp = '192.0.2.200';
    expect(await attempt(SEED, 'correct-password')).toBe(OK);

    for (let i = 0; i < STAFF_U_CAP; i++) {
      currentIp = `203.0.113.${i}`;
      expect(await attempt('ops', 'wrong')).toBe(GENERIC);
    }
    currentIp = '203.0.113.99';
    expect(await attempt('ops', 'wrong')).toBe(THROTTLED); // attempt 31
    currentIp = '192.0.2.201';
    expect(await attempt('ops', 'correct-password')).toBe(THROTTLED);
  });

  it('a same-named account that is NOT a platform admin inherits no exemption', async () => {
    await pgPartnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff(row({ username: SEED, partnerId: 'acme' }));
    for (let i = 0; i < STAFF_U_CAP; i++) {
      currentIp = `203.0.113.${i}`;
      await attempt(SEED, 'wrong');
    }
    currentIp = '192.0.2.202';
    expect(await attempt(SEED, 'correct-password')).toBe(THROTTLED);
  });

  it('the seed admin is still bounded per IP by the ui bucket (10 per hour)', async () => {
    currentIp = '198.51.100.9';
    for (let i = 0; i < 10; i++) expect(await attempt(SEED, 'wrong')).toBe(GENERIC);
    expect(await attempt(SEED, 'wrong')).toBe(THROTTLED);
    currentIp = '198.51.100.10'; // the owner, elsewhere
    expect(await attempt(SEED, 'correct-password')).toBe(OK);
  });

  it('20 successful logins do not throttle', async () => {
    for (let i = 0; i < 20; i++) {
      if (i % 10 === 0) clock += 61_000; // stay inside the outer ring (it counts every POST)
      expect(await attempt('ops', 'correct-password')).toBe(OK);
    }
    expect(redis.dump.has(staffLoginKeys.ip(currentIp, clock))).toBe(false);
    expect(redis.dump.has(staffLoginKeys.u('ops', clock))).toBe(false);
    expect(redis.dump.has(staffLoginKeys.ui('ops', currentIp, clock))).toBe(false);
    // The full ui budget is still there.
    clock += 61_000;
    for (let i = 0; i < 10; i++) expect(await attempt('ops', 'wrong')).toBe(GENERIC);
  });

  it('refuses the 11th attempt from one IP with the SAME string for known and unknown usernames', async () => {
    for (let i = 0; i < 10; i++) await attempt('ops', 'wrong');
    expect(await attempt('ops', 'wrong')).toBe(THROTTLED);
    clock += 61_000;
    for (let i = 0; i < 10; i++) await attempt('ghost', 'wrong');
    expect(await attempt('ghost', 'wrong')).toBe(THROTTLED);
  });

  it('the outer ring refuses the 21st POST in a minute (for a non-seed username)', async () => {
    for (let i = 0; i < 20; i++) await attempt(`u${i}`, 'wrong');
    expect(await attempt('ops', 'correct-password')).toBe(THROTTLED);
  });
});

describe('auth.* audit trail (Program-Fix 17a)', { retry: 0 }, () => {
  it('N throttled attempts write 1 row', async () => {
    for (let i = 0; i < 15; i++) await attempt('ops', 'wrong');
    expect(audited.filter((e) => e.action === 'auth.login.failed')).toHaveLength(10);
    const throttled = audited.filter((e) => e.action === 'auth.login.throttled');
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).toMatchObject({ actorType: 'system', actor: 'login', subjectId: 'ops', meta: { bucket: 'ui' } });
  });

  it('a success writes auth.login (actor staff, partnerId for partner staff); an unknown username is never stored', async () => {
    await pgPartnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff(row({ username: 'pstaff', role: 'agent', partnerId: 'acme' }));
    expect(await attempt('pstaff', 'correct-password')).toBe(OK);
    expect(audited.at(-1)).toMatchObject({
      action: 'auth.login', actorType: 'staff', actor: 'pstaff', subjectId: 'pstaff', partnerId: 'acme',
    });
    expect(typeof (audited.at(-1)!.meta as { ipHash?: string }).ipHash).toBe('string');

    await attempt('my-secret-pasted-here', 'x');
    const failed = audited.at(-1)!;
    expect(failed).toMatchObject({ action: 'auth.login.failed', actorType: 'system', actor: 'login' });
    expect(failed.subjectId).toBeUndefined();
    expect(JSON.stringify(audited)).not.toContain('my-secret-pasted-here');
    expect(JSON.stringify(audited)).not.toContain(currentIp);
  });

  it('audit insert throws → login still succeeds', async () => {
    auditRecord = async () => {
      throw new Error('neon down');
    };
    expect(await attempt('ops', 'correct-password')).toBe(OK);
    expect(cookieJar.size).toBe(1);
  });

  it('audit insert hangs → login completes', async () => {
    auditRecord = () => new Promise<void>(() => {});
    auditTimeoutMs = 25;
    expect(await attempt('ops', 'wrong')).toBe(GENERIC);
    expect(await attempt('ops', 'correct-password')).toBe(OK);
  });

  it('logout writes auth.logout', async () => {
    expect(await attempt('ops', 'correct-password')).toBe(OK);
    await expect(logout()).rejects.toThrow('REDIRECT:/login');
    expect(audited.at(-1)).toMatchObject({ action: 'auth.logout', actorType: 'staff', actor: 'ops', subjectId: 'ops' });
  });
});
