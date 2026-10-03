import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';

// Lost-features A14: /partner/security changes the signed-in member's own password through the ONE
// core (staff-password-change.ts). Every partner role (finance too); a member still waiting to enrol
// in two-step sign-in is sent to enrolment first; the action acts on the session user only.
const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value, 'x-forwarded-for': '198.51.100.20' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth-store')>();
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-store')>();
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});
vi.mock('@/lib/staff-login-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/staff-login-guard')>();
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis) };
});
const audited: import('@/db/repos/aux-repos').AuditEvent[] = [];
vi.mock('@/lib/staff-auth-audit', async (orig) => {
  const actual = await orig<typeof import('@/lib/staff-auth-audit')>();
  return { ...actual, getStaffAuthAudit: () => actual.createStaffAuthAudit({ record: async (e) => void audited.push(e), ipKey: () => Buffer.alloc(32, 1) }) };
});
vi.mock('@/lib/pwned', async (orig) => ({ ...(await orig<typeof import('@/lib/pwned')>()), pwnedPasswordStatus: async () => 'clean' as const }));

import { changePasswordAction } from '@/app/partner/(app)/security/password-actions';
import { createAuthStore } from '@/lib/auth-store';
import { hashPassword, verifyPassword } from '@/lib/password';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { t } from '@/lib/i18n';
import type { StaffRole } from '@/lib/types';

const store = createAuthStore(redis);
const OLD = 'old-password-123';
const NEW = 'fresh-password-456';
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
const submit = (current = OLD, next = NEW, confirm = next, extra: Record<string, string> = {}) =>
  changePasswordAction(null, form({ currentPassword: current, newPassword: next, confirmPassword: confirm, ...extra }));
const as = async (role: StaffRole, username = `pa-${role}`) =>
  signInAs(redis, cookieJar, { username, role, partnerId: 'pa', passwordHash: await hashPassword(OLD) });

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  redis.dump.clear();
  cookieJar.clear();
  audited.length = 0;
  host.value = 'smartremit.ai';
});

describe('changePasswordAction: the gate', () => {
  it('anonymous → /login; platform → /admin-dashboard', async () => {
    await expect(submit()).rejects.toThrow('REDIRECT:/login');
    await signInAs(redis, cookieJar, { username: 'plat', partnerId: undefined, role: 'admin' });
    await expect(submit()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('a member waiting to enrol in two-step sign-in is sent to enrolment, nothing changed', async () => {
    await as('agent');
    await redis.set(`${MFA_PENDING_PREFIX}pa-agent`, '1');
    await expect(submit()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
    expect(await verifyPassword(OLD, (await store.getStaff('pa-agent'))!.passwordHash)).toBe(true);
  });
  it('a partner subdomain → 404', async () => {
    await as('agent');
    host.value = 'acme.smartremit.ai';
    await expect(submit()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

describe('changePasswordAction: every role changes its own password', () => {
  it.each(['admin', 'agent', 'support', 'finance'] as const)('%s', async (role) => {
    await as(role);
    const old = cookieJar.get(SESSION_COOKIE)!;
    expect(await submit()).toEqual({ ok: true });
    expect(await verifyPassword(NEW, (await store.getStaff(`pa-${role}`))!.passwordHash)).toBe(true);
    expect(await store.getSessionUser(old)).toBeNull();
    expect(await store.getSessionUser(cookieJar.get(SESSION_COOKIE)!)).toBe(`pa-${role}`);
    expect(audited.at(-1)).toMatchObject({ action: 'auth.password.change', actor: `pa-${role}`, partnerId: 'pa' });
  });

  it('a username in the form is ignored: only the session user changes', async () => {
    await signInAs(redis, cookieJar, { username: 'pa-other', role: 'agent', partnerId: 'pa', passwordHash: await hashPassword(OLD) });
    const otherHash = (await store.getStaff('pa-other'))!.passwordHash;
    await as('agent');
    expect(await submit(OLD, NEW, NEW, { username: 'pa-other' })).toEqual({ ok: true });
    expect((await store.getStaff('pa-other'))!.passwordHash).toBe(otherHash);
    expect(await verifyPassword(NEW, (await store.getStaff('pa-agent'))!.passwordHash)).toBe(true);
  });
});

describe('changePasswordAction: refusals are fixed copy', () => {
  beforeEach(() => as('agent'));
  it('missing, mismatch, wrong current, same', async () => {
    expect(await submit('', NEW)).toEqual({ ok: false, error: t('partner.security.password.error.missing') });
    expect(await submit(OLD, NEW, 'something-else-1')).toEqual({ ok: false, error: t('partner.security.password.error.mismatch') });
    expect(await submit('not-the-password', NEW)).toEqual({ ok: false, error: t('partner.security.password.error.wrongCurrent') });
    expect(await submit(OLD, OLD)).toEqual({ ok: false, error: t('partner.security.password.error.same') });
  });
  it('the policy message shows as is', async () => {
    expect(await submit(OLD, 'short')).toEqual({ ok: false, error: 'Password must be at least 12 characters.' });
  });
  it('throttled after ten wrong guesses (the sign-in buckets)', async () => {
    for (let i = 0; i < 10; i++) await submit('nope-nope-nope', NEW);
    expect(await submit()).toEqual({ ok: false, error: t('partner.security.password.error.throttled') });
  });
});
