import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined,
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (n: string) => cookieJar.delete(n),
  }),
}));
const redirectMock = vi.hoisted(() => vi.fn((p: string) => { throw new Error('REDIRECT:' + p); }));
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

import { login } from '@/app/login/actions';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { hashPassword } from '@/lib/password';

beforeEach(() => { redis.dump.clear(); cookieJar.clear(); redirectMock.mockClear(); });
afterEach(() => vi.clearAllMocks());

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe('login action with partner suspension', () => {
  it('allows login when the staff\'s partner is active', async () => {
    await getPartnerStore().savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z', partnerId: 'acme',
    });
    await expect(login(null, form({ username: 'p', password: 'hunter2' })))
      .rejects.toThrow('REDIRECT:/admin-dashboard');
  });

  it('rejects login (generic error) when the partner is suspended', async () => {
    await getPartnerStore().savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z', partnerId: 'acme',
    });
    const result = await login(null, form({ username: 'p', password: 'hunter2' }));
    expect(result).toMatch(/account unavailable/i);
    // No session cookie set
    expect(cookieJar.size).toBe(0);
  });

  it('rejects login when the partner record is missing', async () => {
    await getAuthStore().saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z', partnerId: 'ghost',
    });
    const result = await login(null, form({ username: 'p', password: 'hunter2' }));
    expect(result).toMatch(/account unavailable/i);
  });

  it('platform staff login is unaffected by partner status', async () => {
    await getPartnerStore().savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff({
      username: 'admin', name: 'Admin', role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z',
    });
    await expect(login(null, form({ username: 'admin', password: 'hunter2' })))
      .rejects.toThrow('REDIRECT:/admin-dashboard');
  });
});
