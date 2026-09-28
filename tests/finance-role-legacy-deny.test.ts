import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Staff } from '@/lib/types';

// UI redesign M3-6: 'finance' is a /partner-only role. Every legacy /admin-dashboard gate
// (all of them go through requireStaff) sends it to /partner; a role outside the closed set
// fails closed to /login. The self-service account actions use requireStaffSelf so a finance
// member can still enrol MFA and change a password from /partner/security.
// Harness: the M3 one (tests/partner-gate.test.ts).
const redis = fakeRedis();
let pgPartnerStore: PartnerStore;
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/staff-login-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-login-guard')>('@/lib/staff-login-guard');
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis) };
});

import * as auth from '@/lib/auth';
import { isLegacyDashboardStaff } from '@/lib/legacy-dashboard-staff';
import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { PARTNER_ANY, PARTNER_MONEY_READ, PARTNER_OPS } from '@/lib/partner-access';
import { beginMfaEnrolmentAction, confirmMfaEnrolmentAction } from '@/app/admin-dashboard/account/actions';
import { changeOwnPasswordAction } from '@/app/admin-dashboard/team/actions';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const FINANCE = 'finance' as Staff['role'];
async function signInAs(o: Partial<Staff>): Promise<Staff> {
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
  return s;
}

// Exact matches: a substring match on 'REDIRECT:/partner' would also pass '/partner/security?enroll=1'.
const TO_PARTNER = /^REDIRECT:\/partner$/;
const TO_LOGIN = /^REDIRECT:\/login$/;

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  const db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, 'pa');
});

// Every legacy gate exported by auth.ts. Each one resolves the session through requireStaff.
const GATES = [
  'requireStaff',
  'requireAdmin',
  'requirePlatformAdmin',
  'requireScope',
  'requireOpsStaff',
  'requireSupportOrAdmin',
  'requireTicketWorker',
] as const;

describe('M3-6: legacy dashboard gates deny finance', () => {
  it.each(GATES)('%s sends a finance account to /partner (no legacy surface)', async (g) => {
    await signInAs({ partnerId: 'pa', role: FINANCE });
    await expect((auth[g] as () => Promise<unknown>)()).rejects.toThrow(TO_PARTNER);
  });

  it.each(GATES)('%s sends a role outside the closed set to /login (fail closed, never /partner)', async (g) => {
    await signInAs({ partnerId: 'pa', role: 'root' as Staff['role'] });
    await expect((auth[g] as () => Promise<unknown>)()).rejects.toThrow(TO_LOGIN);
  });

  it('a platform-scoped unknown role terminates at /login (no /partner <-> /admin-dashboard loop)', async () => {
    await signInAs({ partnerId: undefined, role: 'root' as Staff['role'] });
    // /partner sends platform scope to /admin-dashboard, whose requireStaff ends the chain at /login.
    await expect(auth.requirePartnerStaff(PARTNER_ANY)).rejects.toThrow(/^REDIRECT:\/admin-dashboard$/);
    await expect(auth.requireStaff()).rejects.toThrow(TO_LOGIN);
  });

  it('a platform-scoped finance record terminates at /login (the redirect chain is walked once)', async () => {
    await signInAs({ partnerId: undefined, role: FINANCE });
    await expect(auth.requireStaff()).rejects.toThrow(TO_PARTNER); // hop 1
    await expect(auth.requirePartnerStaff(PARTNER_ANY)).rejects.toThrow(TO_LOGIN); // hop 2 ends
  });

  it('requireStaffSelf admits finance (MFA enrolment at /partner/security)', async () => {
    await signInAs({ partnerId: 'pa', role: FINANCE });
    await expect(auth.requireStaffSelf()).resolves.toMatchObject({ role: 'finance' });
  });

  it('requireStaffSelf still sends anonymous and suspended sessions to /login', async () => {
    await expect(auth.requireStaffSelf()).rejects.toThrow(TO_LOGIN);
    await signInAs({ partnerId: 'pa', role: FINANCE, status: 'suspended' });
    await expect(auth.requireStaffSelf()).rejects.toThrow(TO_LOGIN);
  });

  it('isLegacyDashboardStaff is a closed allowlist: admin, agent, support only', () => {
    const mk = (role: string) => ({ role }) as Staff;
    expect(isLegacyDashboardStaff(mk('admin'))).toBe(true);
    expect(isLegacyDashboardStaff(mk('agent'))).toBe(true);
    expect(isLegacyDashboardStaff(mk('support'))).toBe(true);
    expect(isLegacyDashboardStaff(mk('finance'))).toBe(false);
    expect(isLegacyDashboardStaff(mk('root'))).toBe(false);
    expect(isLegacyDashboardStaff(mk(''))).toBe(false);
  });

  it('existing roles are unchanged by the new branch', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await expect(auth.requireScope()).resolves.toMatchObject({ staff: expect.objectContaining({ role: 'agent' }) });
    await signInAs({ partnerId: 'pa', role: 'support' });
    await expect(auth.requireSupportOrAdmin()).resolves.toMatchObject({
      staff: expect.objectContaining({ role: 'support' }),
    });
    await signInAs({ partnerId: undefined, role: 'admin' });
    await expect(auth.requirePlatformAdmin()).resolves.toMatchObject({ role: 'admin' });
  });

  it('requirePartnerStaff admits finance on PARTNER_MONEY_READ and refuses PARTNER_OPS', async () => {
    await signInAs({ partnerId: 'pa', role: FINANCE });
    await expect(auth.requirePartnerStaff(PARTNER_MONEY_READ)).resolves.toMatchObject({ role: 'finance' });
    await expect(auth.requirePartnerStaff(PARTNER_OPS)).rejects.toThrow(TO_PARTNER);
  });
});

describe('M3-6: the self-service account actions admit finance (requireStaffSelf)', () => {
  it('beginMfaEnrolmentAction runs for a finance member (no redirect)', async () => {
    await signInAs({ partnerId: 'pa', role: FINANCE });
    await expect(beginMfaEnrolmentAction({ ok: false }, new FormData())).resolves.toMatchObject({ ok: false });
  });
  it('confirmMfaEnrolmentAction runs for a finance member (no redirect)', async () => {
    await signInAs({ partnerId: 'pa', role: FINANCE });
    const fd = new FormData();
    fd.set('code', '000000');
    await expect(confirmMfaEnrolmentAction({ ok: false }, fd)).resolves.toMatchObject({ ok: false });
  });
  it('changeOwnPasswordAction runs for a finance member (no redirect)', async () => {
    await signInAs({ partnerId: 'pa', role: FINANCE });
    await expect(changeOwnPasswordAction({ ok: false, message: '' }, new FormData())).resolves.toMatchObject({ ok: false });
  });
  it('the self-service actions still refuse an anonymous session', async () => {
    await expect(beginMfaEnrolmentAction({ ok: false }, new FormData())).rejects.toThrow(TO_LOGIN);
    await expect(changeOwnPasswordAction({ ok: false, message: '' }, new FormData())).rejects.toThrow(TO_LOGIN);
  });
});
