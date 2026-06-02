import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerStore } from '@/lib/partner-store';

// Mock next/headers + next/navigation BEFORE importing auth.ts
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined,
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  }),
}));
const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string) => { throw new Error('REDIRECT:' + path); }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

// Shared redis so auth-store + partner-store see the same data
const redis = fakeRedis();
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(redis) };
});

import { getCurrentStaff, requirePlatformAdmin } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';

beforeEach(() => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('getCurrentStaff suspended-partner bounce', () => {
  it('returns the staff for an active-partner session', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    await partnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p');
    cookieJar.set(SESSION_COOKIE, token);

    const staff = await getCurrentStaff();
    expect(staff?.username).toBe('p');
  });

  it('returns null when the staff\'s partner is suspended', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    await partnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p');
    cookieJar.set(SESSION_COOKIE, token);

    expect(await getCurrentStaff()).toBeNull();
  });

  it('platform staff are unaffected by any partner\'s status', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    await partnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'admin', name: 'Admin', role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      // No partnerId → platform.
    });
    const token = await authStore.createSession('admin');
    cookieJar.set(SESSION_COOKIE, token);

    expect((await getCurrentStaff())?.username).toBe('admin');
  });
});

describe('requirePlatformAdmin', () => {
  it('returns the staff for a platform admin', async () => {
    const authStore = getAuthStore();
    await authStore.saveStaff({
      username: 'admin', name: 'Admin', role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    });
    const token = await authStore.createSession('admin');
    cookieJar.set(SESSION_COOKIE, token);

    const staff = await requirePlatformAdmin();
    expect(staff.username).toBe('admin');
  });

  it('redirects /admin-dashboard when role is agent', async () => {
    const authStore = getAuthStore();
    await authStore.saveStaff({
      username: 'a', name: 'A', role: 'agent',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    });
    const token = await authStore.createSession('a');
    cookieJar.set(SESSION_COOKIE, token);

    await expect(requirePlatformAdmin()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });

  it('redirects /admin-dashboard when staff has a partnerId (partner-admin, not platform)', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    await partnerStore.savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'pa', name: 'PA', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('pa');
    cookieJar.set(SESSION_COOKIE, token);

    await expect(requirePlatformAdmin()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
});
