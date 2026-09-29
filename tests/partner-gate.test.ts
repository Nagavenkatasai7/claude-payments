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

import { requirePartnerStaff, requireScope, requireStaff, requireStaffSelf, requireTicketWorker } from '@/lib/auth';
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
    // M3-6 made 'finance' a known role; the fail-closed case now uses a role outside the set.
    await signInAs({ partnerId: 'pa', role: 'root' as Staff['role'] });
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

// UI redesign M3-9 (O10 = yes): the legacy /admin-dashboard gates honour the invite marker, so an
// invitee cannot skip enrolment by opening the old dashboard directly. requireStaffSelf (the
// enrolment + own-password actions) stays exempt, or enrolment itself would be unreachable.
describe('legacy gates and the invite marker (M3-9, O10)', () => {
  it('a marked, unenrolled partner agent → requireScope / requireStaff / requireTicketWorker send it to enrolment', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    await expect(requireScope()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    await expect(requireStaff()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    await expect(requireTicketWorker()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
  });
  it('an unmarked partner agent is unchanged', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await expect(requireScope()).resolves.toMatchObject({ staff: { username: 'u1' } });
  });
  it('requireStaffSelf admits the marked account (the enrolment actions stay reachable)', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    await expect(requireStaffSelf()).resolves.toMatchObject({ username: 'u1' });
    expect(await redis.get(`${MFA_PENDING_PREFIX}u1`)).toBe('1');
  });
  it('a platform admin is never affected, even with a stray marker under its name', async () => {
    await signInAs({ partnerId: undefined, role: 'admin' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    await expect(requireStaff()).resolves.toMatchObject({ username: 'u1' });
  });
  it('marked but enrolled → admitted, and the marker is cleared', async () => {
    await signInAs({ partnerId: 'pa', role: 'agent' });
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    const mfa = (await import('@/lib/staff-mfa-store')).getStaffMfaStore();
    const begun = await mfa.beginEnrolment('u1');
    if (!begun.ok) throw new Error('enrol refused');
    const { base32Decode, totpAt } = await import('@/lib/totp');
    expect(await mfa.confirmEnrolment('u1', totpAt(base32Decode(begun.secretBase32), Date.now()))).toBe('ok');
    await expect(requireScope()).resolves.toMatchObject({ staff: { username: 'u1' } });
    expect(await redis.get(`${MFA_PENDING_PREFIX}u1`)).toBeNull();
  });
});
