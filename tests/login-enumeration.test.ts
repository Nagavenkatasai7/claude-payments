/**
 * Fix 21 (F62) — staff sign-in stops revealing which usernames exist.
 *
 *  - An unknown username runs the SAME Argon2id verify (against a dummy hash)
 *    as a known one, and returns the same generic error.
 *  - A legacy scrypt `salt:hash` is rehashed to Argon2id on a successful login
 *    (re-reading the fresh record, so a suspended member is never resurrected).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scryptSync, randomBytes } from 'node:crypto';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';

const redis = fakeRedis();
let pgPartnerStore: PartnerStore;
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
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/seed', () => ({ ensureSeedAdmin: async () => {} }));

// Partial mock: the real password module, with a spy on the one function the
// login action must call on EVERY attempt.
const pw = vi.hoisted(() => ({ verifyPasswordOrDummy: vi.fn() }));
vi.mock('@/lib/password', async () => {
  const actual = await vi.importActual<typeof import('@/lib/password')>('@/lib/password');
  pw.verifyPasswordOrDummy.mockImplementation(actual.verifyPasswordOrDummy);
  return { ...actual, verifyPasswordOrDummy: pw.verifyPasswordOrDummy };
});

import { login } from '@/app/login/actions';
import { getAuthStore } from '@/lib/auth-store';
import { hashPassword, verifyPassword } from '@/lib/password';
import type { Staff } from '@/lib/types';

const GENERIC = 'Invalid username or password.';

function legacyScryptHash(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(plain, salt, 64).toString('hex')}`;
}

function staffRow(over: Partial<Staff> & { passwordHash: string }): Staff {
  return {
    username: 'ops',
    name: 'Ops',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    createdAt: '2026-05-27T00:00:00Z',
    ...over,
  };
}

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  pw.verifyPasswordOrDummy.mockClear();
  pgPartnerStore = createPartnerStore(await freshDb());
});
afterEach(() => vi.clearAllMocks());

describe('staff login is not a username oracle (fix 21)', () => {
  it('an unknown username still runs one Argon2 verify (stored = undefined) and gets the generic error', async () => {
    const result = await login(null, form({ username: 'nobody-here', password: 'whatever-pw' }));
    expect(result).toBe(GENERIC);
    expect(pw.verifyPasswordOrDummy).toHaveBeenCalledTimes(1);
    expect(pw.verifyPasswordOrDummy).toHaveBeenCalledWith('whatever-pw', undefined);
    expect(cookieJar.size).toBe(0);
  });

  it('a known username with a wrong password gets the SAME string', async () => {
    await getAuthStore().saveStaff(staffRow({ passwordHash: await hashPassword('right-pw') }));
    const result = await login(null, form({ username: 'ops', password: 'wrong-pw' }));
    expect(result).toBe(GENERIC);
    expect(pw.verifyPasswordOrDummy).toHaveBeenCalledTimes(1);
    expect(cookieJar.size).toBe(0);
  });
});

describe('staff lazy scrypt → Argon2id rehash (fix 21)', () => {
  it('rehashes a legacy salt:hash on a successful login, and the same password still logs in', async () => {
    await getAuthStore().saveStaff(staffRow({ passwordHash: legacyScryptHash('legacy-pw') }));
    await expect(login(null, form({ username: 'ops', password: 'legacy-pw' }))).rejects.toThrow(
      'REDIRECT:/admin-dashboard',
    );
    const stored = (await getAuthStore().getStaff('ops'))!;
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('legacy-pw', stored.passwordHash)).toBe(true);
    expect(stored.lastLoginAt).toBeTruthy(); // recordLogin still ran after the rehash
    expect(stored.role).toBe('admin'); // nothing else on the record changed

    cookieJar.clear();
    await expect(login(null, form({ username: 'ops', password: 'legacy-pw' }))).rejects.toThrow(
      'REDIRECT:/admin-dashboard',
    );
    // Already Argon2id: a second login does not rewrite the hash.
    expect((await getAuthStore().getStaff('ops'))!.passwordHash).toBe(stored.passwordHash);
  });

  it('a suspended member is never rehashed (login refuses before the rehash; the store no-ops too)', async () => {
    const legacy = legacyScryptHash('legacy-pw');
    await getAuthStore().saveStaff(staffRow({ passwordHash: legacy, status: 'suspended' }));
    const result = await login(null, form({ username: 'ops', password: 'legacy-pw' }));
    expect(result).toMatch(/account unavailable/i);
    expect((await getAuthStore().getStaff('ops'))!.passwordHash).toBe(legacy);

    // The store guard itself: a stale caller can't resurrect / rewrite a suspended record …
    await getAuthStore().updatePasswordHash('ops', await hashPassword('legacy-pw'));
    expect((await getAuthStore().getStaff('ops'))!.passwordHash).toBe(legacy);
    // … and a missing record is never created.
    await getAuthStore().updatePasswordHash('ghost', await hashPassword('x'));
    expect(await getAuthStore().getStaff('ghost')).toBeNull();
    expect(redis.dump.has('staff:ghost')).toBe(false);
  });
});
