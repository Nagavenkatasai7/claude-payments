/**
 * Program-Fix 17b — optional MFA enforcement on the platform-admin surfaces.
 * Off by default; when STAFF_MFA_REQUIRED=true an UNENROLLED platform admin is
 * sent to /admin-dashboard/account?enroll=1 (a requireStaff page, so no loop).
 * The seed admin and STAFF_MFA_EXEMPT names are never redirected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import type { Staff } from '@/lib/types';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n)! } : undefined),
    set: () => {},
    delete: () => {},
  }),
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
const isEnrolledSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return {
    ...actual,
    getStaffMfaStore: () => {
      const s = actual.createStaffMfaStore(redis);
      return {
        ...s,
        isEnrolled: (u: string) => {
          isEnrolledSpy(u);
          return s.isEnrolled(u);
        },
      };
    },
  };
});

import { requirePlatformAdmin, requireStaff } from '@/lib/auth';
import { createAuthStore } from '@/lib/auth-store';
import { createStaffMfaStore } from '@/lib/staff-mfa-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { base32Decode, totpAt } from '@/lib/totp';

const ENROL = 'REDIRECT:/admin-dashboard/account?enroll=1';

function row(over: Partial<Staff>): Staff {
  return {
    username: 'ops',
    name: 'Ops',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'x',
    createdAt: '2026-05-27T00:00:00Z',
    ...over,
  };
}

async function signInAs(s: Staff) {
  const store = createAuthStore(redis);
  await store.saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await store.createSession(s.username));
}

async function outcome(p: Promise<Staff>): Promise<string> {
  try {
    return `OK:${(await p).username}`;
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  redis.dump.clear();
  cookieJar.clear();
  isEnrolledSpy.mockClear();
});
afterEach(() => {
  delete process.env.STAFF_MFA_REQUIRED;
  delete process.env.STAFF_MFA_EXEMPT;
});

describe('MFA enforcement (Program-Fix 17b)', () => {
  it('flag off (default): an unenrolled platform admin passes, and no MFA read happens', async () => {
    await signInAs(row({}));
    expect(await outcome(requirePlatformAdmin())).toBe('OK:ops');
    expect(isEnrolledSpy).not.toHaveBeenCalled();
  });

  it('flag on: an unenrolled platform admin is sent to enrol', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    await signInAs(row({}));
    expect(await outcome(requirePlatformAdmin())).toBe(ENROL);
  });

  it('flag on: the enrolment page itself (requireStaff) never redirects (no loop)', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    await signInAs(row({}));
    expect(await outcome(requireStaff())).toBe('OK:ops');
  });

  it('flag on: an enrolled platform admin passes', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    await signInAs(row({}));
    const mfa = createStaffMfaStore(redis);
    const b = await mfa.beginEnrolment('ops');
    if (!b.ok) throw new Error();
    expect(await mfa.confirmEnrolment('ops', totpAt(base32Decode(b.secretBase32), Date.now()))).toBe('ok');
    expect(await outcome(requirePlatformAdmin())).toBe('OK:ops');
  });

  it('flag on: the seed admin is never redirected, never refused', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    await signInAs(row({ username: 'admin' }));
    expect(await outcome(requirePlatformAdmin())).toBe('OK:admin');
  });

  it('flag on: the E2E user listed in STAFF_MFA_EXEMPT is not redirected', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    process.env.STAFF_MFA_EXEMPT = 'e2e-admin';
    await signInAs(row({ username: 'e2e-admin' }));
    expect(await outcome(requirePlatformAdmin())).toBe('OK:e2e-admin');
  });
});
