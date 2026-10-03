import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createAuthStore } from '@/lib/auth-store';
import type { Staff } from '@/lib/types';

// Lost-features A14: the ONE own-password-change core behind the legacy /admin-dashboard/account
// action and the new /partner/security action. It answers a closed code; each surface maps the
// codes to its own copy (the legacy wrapper keeps its exact English messages, team-actions.test.ts).
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.20' }),
}));
vi.mock('@/lib/staff-login-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/staff-login-guard')>();
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis) };
});
const audited: import('@/db/repos/aux-repos').AuditEvent[] = [];
vi.mock('@/lib/staff-auth-audit', async (orig) => {
  const actual = await orig<typeof import('@/lib/staff-auth-audit')>();
  return { ...actual, getStaffAuthAudit: () => actual.createStaffAuthAudit({ record: async (e) => void audited.push(e), ipKey: () => Buffer.alloc(32, 1) }) };
});
const pwned = vi.hoisted(() => vi.fn(async (_pw: string): Promise<'pwned' | 'clean' | 'unavailable'> => 'clean'));
vi.mock('@/lib/pwned', async (orig) => ({ ...(await orig<typeof import('@/lib/pwned')>()), pwnedPasswordStatus: pwned }));
vi.mock('@/lib/auth-store', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth-store')>();
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});

import { changeOwnPassword } from '@/lib/staff-password-change';
import { hashPassword, verifyPassword } from '@/lib/password';
import { staffLoginKeys } from '@/lib/staff-login-guard';
import { SESSION_COOKIE } from '@/lib/session-cookie';

const store = createAuthStore(redis);
let me: Staff;
const OLD = 'old-password-123';
const NEW = 'fresh-password-456';
const change = (current: string, next: string, confirm = next) => changeOwnPassword(me, { current, next, confirm });
const hashNow = async () => (await store.getStaff('pa-agent'))!.passwordHash;

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  audited.length = 0;
  pwned.mockReset();
  pwned.mockImplementation(async () => 'clean');
  me = {
    username: 'pa-agent',
    name: 'Andy',
    role: 'agent',
    partnerId: 'pa',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: await hashPassword(OLD),
    createdAt: '2026-01-01T00:00:00Z',
  };
  await store.saveStaff(me);
});

describe('changeOwnPassword', () => {
  it('missing and mismatch: refused before any attempt is reserved', async () => {
    expect(await change('', NEW)).toEqual({ ok: false, code: 'missing' });
    expect(await change(OLD, '')).toEqual({ ok: false, code: 'missing' });
    expect(await change(OLD, NEW, 'something-else-1')).toEqual({ ok: false, code: 'mismatch' });
    expect(redis.dump.has(staffLoginKeys.u('pa-agent', Date.now()))).toBe(false);
  });

  it('a gone account', async () => {
    await store.deleteStaff('pa-agent');
    expect(await change(OLD, NEW)).toEqual({ ok: false, code: 'gone' });
  });

  it('wrong current: counted on the login buckets and audited auth.login.failed; the 11th is throttled', async () => {
    expect(await change('not-the-password', NEW)).toEqual({ ok: false, code: 'wrong_current' });
    expect(redis.dump.get(staffLoginKeys.u('pa-agent', Date.now()))).toBe('1');
    expect(audited.at(-1)).toMatchObject({ action: 'auth.login.failed', actor: 'pa-agent', partnerId: 'pa', meta: { reason: 'invalid', context: 'password.change' } });
    for (let i = 0; i < 9; i++) await change('nope-nope-nope', NEW);
    expect(await change(OLD, NEW)).toEqual({ ok: false, code: 'throttled' });
    expect(audited.some((e) => e.action === 'auth.login.throttled')).toBe(true);
    expect(await verifyPassword(OLD, await hashNow())).toBe(true);
  });

  it('same password and policy refusals carry no write; the policy message is passed through', async () => {
    expect(await change(OLD, OLD)).toEqual({ ok: false, code: 'same' });
    expect(await change(OLD, 'short')).toEqual({ ok: false, code: 'policy', policyMessage: 'Password must be at least 12 characters.' });
    pwned.mockImplementation(async () => 'pwned');
    expect(await change(OLD, NEW)).toMatchObject({ ok: false, code: 'policy', policyMessage: expect.stringMatching(/breach/) });
    expect(await verifyPassword(OLD, await hashNow())).toBe(true);
  });

  it('success: new hash, every old session revoked, one fresh session cookie, auth.password.change, counters cleared', async () => {
    await change('wrong-guess-zzz', NEW); // one counted miss, cleared by the success
    const old = await store.createSession('pa-agent');
    expect(await change(OLD, NEW)).toEqual({ ok: true });
    expect(await store.getSessionUser(old)).toBeNull();
    const fresh = cookieJar.get(SESSION_COOKIE);
    expect(await store.getSessionUser(fresh!)).toBe('pa-agent');
    expect(await verifyPassword(NEW, await hashNow())).toBe(true);
    expect(audited.at(-1)).toMatchObject({ action: 'auth.password.change', actorType: 'staff', actor: 'pa-agent', subjectId: 'pa-agent', partnerId: 'pa' });
    expect(redis.dump.has(staffLoginKeys.u('pa-agent', Date.now()))).toBe(false);
  });

  it('an HIBP outage does not block a self-change (fail-open)', async () => {
    pwned.mockImplementation(async () => 'unavailable');
    expect(await change(OLD, NEW)).toEqual({ ok: true });
  });

  it('a concurrent reset between verify and write is reported, never overwritten', async () => {
    const raced = await hashPassword('admin-reset-password');
    pwned.mockImplementationOnce(async () => {
      await store.saveStaff({ ...(await store.getStaff('pa-agent'))!, passwordHash: raced });
      return 'clean';
    });
    expect(await change(OLD, NEW)).toEqual({ ok: false, code: 'concurrent' });
    expect(await hashNow()).toBe(raced);
  });
});
