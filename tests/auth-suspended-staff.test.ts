import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

/** Team: a suspended staff member is locked out at login AND mid-session. */

const redis = fakeRedis();
const cookieJar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (n: string) => cookieJar.delete(n),
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
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(redis) };
});
vi.mock('@/lib/seed', () => ({ ensureSeedAdmin: async () => {} }));

import { getCurrentStaff } from '@/lib/auth';
import { login } from '@/app/login/actions';
import { getAuthStore } from '@/lib/auth-store';
import { hashPassword } from '@/lib/password';
import { SESSION_COOKIE } from '@/lib/session-cookie';

beforeEach(() => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe('getCurrentStaff suspended-staff bounce', () => {
  it('returns null for a suspended platform staff (mid-session lockout)', async () => {
    const authStore = getAuthStore();
    await authStore.saveStaff({
      username: 'a',
      name: 'A',
      role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: 'salt:hash',
      createdAt: '2026-05-27T00:00:00Z',
      status: 'suspended',
    });
    const token = await authStore.createSession('a');
    cookieJar.set(SESSION_COOKIE, token);
    expect(await getCurrentStaff()).toBeNull();
  });

  it('returns the staff when status is active (or absent)', async () => {
    const authStore = getAuthStore();
    await authStore.saveStaff({
      username: 'a',
      name: 'A',
      role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: 'salt:hash',
      createdAt: '2026-05-27T00:00:00Z',
      // status absent ⇒ active
    });
    const token = await authStore.createSession('a');
    cookieJar.set(SESSION_COOKIE, token);
    expect((await getCurrentStaff())?.username).toBe('a');
  });
});

describe('login refuses suspended staff', () => {
  it('returns a generic error and sets no cookie', async () => {
    await getAuthStore().saveStaff({
      username: 'a',
      name: 'A',
      role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z',
      status: 'suspended',
    });
    const result = await login(null, form({ username: 'a', password: 'hunter2' }));
    expect(result).toMatch(/account unavailable/i);
    expect(cookieJar.size).toBe(0);
  });

  it('records lastLoginAt on a successful login', async () => {
    await getAuthStore().saveStaff({
      username: 'a',
      name: 'A',
      role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z',
    });
    await expect(login(null, form({ username: 'a', password: 'hunter2' }))).rejects.toThrow(
      'REDIRECT:/admin-dashboard',
    );
    expect((await getAuthStore().getStaff('a'))?.lastLoginAt).toBeTruthy();
  });
});
