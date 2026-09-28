import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Staff } from '@/lib/types';

// The M3 harness: real createAuthStore(fakeRedis) sessions, a PGlite partner store, and
// redirect() mocked to throw like NEXT_REDIRECT. Later /partner test files copy this block.
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

import { requirePartnerStaff } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { PARTNER_ANY, PARTNER_ADMIN, PARTNER_OPS } from '@/lib/partner-access';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
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

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  const db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
});

describe('requirePartnerStaff', () => {
  it('anonymous → /login', async () => {
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/login');
  });
  it('a forged / unknown session token → /login', async () => {
    cookieJar.set(SESSION_COOKIE, 'not-a-real-session');
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/login');
  });
  it('platform admin → /admin-dashboard (also with skipMfa)', async () => {
    await signInAs({ partnerId: undefined });
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/admin-dashboard');
    await expect(requirePartnerStaff(PARTNER_ANY, { skipMfa: true })).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('partner staff of a SUSPENDED partner → /login', async () => {
    await pgPartnerStore.savePartner({ ...(await pgPartnerStore.getPartner('pa'))!, status: 'suspended' });
    await signInAs({ partnerId: 'pa' });
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/login');
  });
  it('partner staff of a MISSING partner → /login', async () => {
    await signInAs({ partnerId: 'nope' });
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/login');
  });
  it('a suspended staff member → /login', async () => {
    await signInAs({ partnerId: 'pa', status: 'suspended' });
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/login');
  });
  it('an unknown role on the stored record → /login (fail closed)', async () => {
    await signInAs({ partnerId: 'pa', role: 'finance' as Staff['role'] });
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/login');
  });
  it('partner agent on an admin surface → /partner; support on an ops surface → /partner', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await expect(requirePartnerStaff(PARTNER_ADMIN)).rejects.toThrow('REDIRECT:/partner');
    await signInAs({ username: 'u2', partnerId: 'pa', role: 'support' });
    await expect(requirePartnerStaff(PARTNER_OPS)).rejects.toThrow('REDIRECT:/partner');
  });
  it('invite marker, not enrolled → enrolment; skipMfa (the security page) passes', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    await expect(requirePartnerStaff(PARTNER_ANY)).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    await expect(requirePartnerStaff(PARTNER_ANY, { skipMfa: true })).resolves.toMatchObject({ partnerId: 'pa' });
    // skipMfa does not read (or clear) the marker.
    expect(await redis.get(`${MFA_PENDING_PREFIX}u1`)).toBe('1');
  });
  it('the ctx tenant is the session record’s', async () => {
    await signInAs({ partnerId: 'pb', role: 'admin' });
    await expect(requirePartnerStaff(PARTNER_ADMIN)).resolves.toMatchObject({ partnerId: 'pb', username: 'u1', role: 'admin' });
  });
  it('takes no request input: the policy and options are its only parameters', () => {
    expect(requirePartnerStaff.length).toBeLessThanOrEqual(2);
  });
});
