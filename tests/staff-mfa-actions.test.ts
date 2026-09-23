/**
 * Program-Fix 17b — MFA enrolment (Account page), the platform-admin MFA
 * reset (Team page), and the MFA keys following a member's removal/creation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createAuditLogStore } from '@/lib/audit-log-store';
import type { Staff } from '@/lib/types';

const redis = fakeRedis();
let actor: Staff;
let partnerStore: import('@/lib/partner-store').PartnerStore;
let auditStore: import('@/lib/audit-log-store').AuditLogStore;
let clock = 1_700_000_015_000;
const cookieJar = new Map<string, string>();

vi.mock('@/lib/auth', () => ({ requirePlatformAdmin: async () => actor, requireStaff: async () => actor }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n)! } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.30' }),
}));
vi.mock('@/lib/staff-login-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-login-guard')>('@/lib/staff-login-guard');
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis, { now: () => clock }) };
});
const authAudited: import('@/db/repos/aux-repos').AuditEvent[] = [];
vi.mock('@/lib/staff-auth-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-auth-audit')>('@/lib/staff-auth-audit');
  return {
    ...actual,
    getStaffAuthAudit: () =>
      actual.createStaffAuthAudit({ record: async (e) => void authAudited.push(e), ipKey: () => Buffer.alloc(32, 1) }),
  };
});
vi.mock('@/lib/pwned', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pwned')>('@/lib/pwned');
  return { ...actual, pwnedPasswordStatus: async () => 'clean' };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => partnerStore };
});
vi.mock('@/lib/audit-log-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit-log-store')>('@/lib/audit-log-store');
  return { ...actual, getAuditLogStore: () => auditStore };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { beginMfaEnrolmentAction, confirmMfaEnrolmentAction } from '@/app/admin-dashboard/account/actions';
import { createStaffAction, removeStaffAction, resetStaffMfaAction } from '@/app/admin-dashboard/team/actions';
import { createStaffMfaStore, staffMfaKeys } from '@/lib/staff-mfa-store';
import { base32Decode, totpAt } from '@/lib/totp';
import { hashPassword } from '@/lib/password';
import { SESSION_COOKIE } from '@/lib/session-cookie';

const authStore = createAuthStore(redis);
const PW = 'x'.repeat(14) + '-fixture';
let PW_HASH: string;
const mfa = () => createStaffMfaStore(redis, { now: () => clock });

function staff(over: Partial<Staff>): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}
const form = (v: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, val] of Object.entries(v)) fd.set(k, val);
  return fd;
};

async function enrolDirect(username: string) {
  const b = await mfa().beginEnrolment(username);
  if (!b.ok) throw new Error();
  expect(await mfa().confirmEnrolment(username, totpAt(base32Decode(b.secretBase32), clock))).toBe('ok');
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  authAudited.length = 0;
  clock = 1_700_000_015_000;
  const db = await freshDb();
  partnerStore = createPartnerStore(db);
  auditStore = createAuditLogStore(db);
  await authStore.saveStaff(staff({ username: 'admin', name: 'Main' }));
  await authStore.saveStaff(staff({ username: 'boss', name: 'Boss' }));
  PW_HASH ??= await hashPassword(PW);
  await authStore.saveStaff(staff({ username: 'ops', name: 'Ops', role: 'agent', passwordHash: PW_HASH }));
  actor = staff({ username: 'boss', name: 'Boss' });
});

describe('MFA enrolment (Account page)', () => {
  it('begin returns the secret and otpauth URI once; confirm with a code enrols and audits auth.mfa.enroll', async () => {
    actor = staff({ username: 'ops', name: 'Ops', role: 'agent' });
    const begun = await beginMfaEnrolmentAction({ ok: false }, form({ currentPassword: PW }));
    expect(begun.ok).toBe(true);
    expect(begun.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(begun.uri).toContain(`secret=${begun.secret}`);
    expect(await mfa().isEnrolled('ops')).toBe(false);

    const wrong = await confirmMfaEnrolmentAction({ ok: false }, form({ code: '000000' }));
    expect(wrong).toEqual({ ok: false, message: 'That code is not valid. Check the time on your device and try again.' });
    expect(await mfa().isEnrolled('ops')).toBe(false);

    const good = totpAt(base32Decode(begun.secret!), clock);
    const done = await confirmMfaEnrolmentAction({ ok: false }, form({ code: good }));
    expect(done.ok).toBe(true);
    expect(await mfa().isEnrolled('ops')).toBe(true);
    const row = authAudited.find((e) => e.action === 'auth.mfa.enroll');
    expect(row).toMatchObject({ actorType: 'staff', actor: 'ops', subjectId: 'ops' });
    // The secret never lands in an audit row.
    expect(JSON.stringify(authAudited)).not.toContain(begun.secret!);
  });

  it('turning MFA on signs out every other session and re-mints this one', async () => {
    actor = staff({ username: 'ops', name: 'Ops', role: 'agent' });
    const other = await authStore.createSession('ops');
    const mine = await authStore.createSession('ops');
    cookieJar.set(SESSION_COOKIE, mine);
    const begun = await beginMfaEnrolmentAction({ ok: false }, form({ currentPassword: PW }));
    const done = await confirmMfaEnrolmentAction(
      { ok: false },
      form({ code: totpAt(base32Decode(begun.secret!), clock) }),
    );
    expect(done.ok).toBe(true);
    expect(await authStore.getSessionUser(other)).toBeNull();
    expect(await authStore.getSessionUser(mine)).toBeNull();
    const fresh = cookieJar.get(SESSION_COOKIE)!;
    expect(fresh).not.toBe(mine);
    expect(await authStore.getSessionUser(fresh)).toBe('ops');
  });

  it('begin needs the current password: a wrong one is refused and counted on the login buckets', async () => {
    actor = staff({ username: 'ops', name: 'Ops', role: 'agent' });
    const r = await beginMfaEnrolmentAction({ ok: false }, form({ currentPassword: 'wrong' }));
    expect(r).toEqual({ ok: false, message: 'Your current password is incorrect.' });
    expect(redis.dump.has(staffMfaKeys.enroll('ops'))).toBe(false);
    for (let i = 0; i < 9; i++) await beginMfaEnrolmentAction({ ok: false }, form({ currentPassword: 'wrong' }));
    const t = await beginMfaEnrolmentAction({ ok: false }, form({ currentPassword: PW }));
    expect(t).toEqual({ ok: false, message: 'Too many attempts. Try again later.' });
  });

  it('refuses to begin while already enrolled, and confirm without a pending enrolment says it expired', async () => {
    actor = staff({ username: 'ops', name: 'Ops', role: 'agent' });
    await enrolDirect('ops');
    const again = await beginMfaEnrolmentAction({ ok: false }, form({ currentPassword: PW }));
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already on/i);
    await mfa().reset('ops');
    const confirm = await confirmMfaEnrolmentAction({ ok: false }, form({ code: '123456' }));
    expect(confirm).toEqual({ ok: false, message: 'The setup expired. Start again.' });
  });
});

describe('resetStaffMfaAction (platform admin)', () => {
  it('turns MFA off for the target, revokes its sessions and audits auth.mfa.reset', async () => {
    await enrolDirect('ops');
    const t = await authStore.createSession('ops');
    await resetStaffMfaAction(form({ username: 'ops' }));
    expect(await mfa().isEnrolled('ops')).toBe(false);
    expect(await authStore.getSessionUser(t)).toBeNull();
    expect(authAudited.find((e) => e.action === 'auth.mfa.reset')).toMatchObject({
      actorType: 'staff',
      actor: 'boss',
      subjectId: 'ops',
    });
  });

  it('only the seed admin can reset the seed admin', async () => {
    await enrolDirect('admin');
    await expect(resetStaffMfaAction(form({ username: 'admin' }))).rejects.toThrow(/main admin/);
    expect(await mfa().isEnrolled('admin')).toBe(true);
    actor = staff({ username: 'admin', name: 'Main' });
    await resetStaffMfaAction(form({ username: 'admin' }));
    expect(await mfa().isEnrolled('admin')).toBe(false);
  });

  it('an unknown target is a no-op (no audit row)', async () => {
    await resetStaffMfaAction(form({ username: 'ghost' }));
    expect(authAudited).toHaveLength(0);
  });
});

describe('MFA keys follow the member', () => {
  it('removeStaffAction deletes the MFA secret', async () => {
    await enrolDirect('ops');
    await removeStaffAction(form({ username: 'ops' }));
    expect(await mfa().isEnrolled('ops')).toBe(false);
  });

  it('createStaffAction clears a stale MFA secret under a re-used username', async () => {
    await enrolDirect('newbie');
    await createStaffAction(
      form({ username: 'newbie', name: 'New', role: 'agent', password: 'a-long-enough-passphrase-9' }),
    );
    expect(await authStore.getStaff('newbie')).not.toBeNull();
    expect(await mfa().isEnrolled('newbie')).toBe(false);
  });
});
