import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

const redis = fakeRedis();

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: async () => ({
    username: 'admin', name: 'Admin', role: 'admin' as const,
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
  }),
}));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createPartnerStaffAction, removePartnerStaffAction } from '@/app/dashboard/partners/actions';
import { createAuthStore } from '@/lib/auth-store';

beforeEach(() => redis.dump.clear());
afterEach(() => vi.clearAllMocks());

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe('createPartnerStaffAction', () => {
  it('creates a staff record scoped to the given partnerId from the URL', async () => {
    await createPartnerStaffAction('acme', form({
      username: 'p1', name: 'Partner One', password: 'hunter2', role: 'admin',
    }));
    const got = await createAuthStore(redis).getStaff('p1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
    expect(got?.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('refuses to honour partnerId from the form (URL param is authoritative)', async () => {
    // The form might try to override partnerId; we ignore it.
    await createPartnerStaffAction('acme', form({
      username: 'p2', name: 'P Two', password: 'pw', role: 'agent',
      partnerId: 'OVERRIDE',
    }));
    const got = await createAuthStore(redis).getStaff('p2');
    expect(got?.partnerId).toBe('acme');
  });

  it('throws on invalid role', async () => {
    await expect(createPartnerStaffAction('acme', form({
      username: 'x', name: 'x', password: 'x', role: 'root',
    }))).rejects.toThrow(/role/i);
  });

  it('throws when any of username, name, password are missing', async () => {
    await expect(createPartnerStaffAction('acme', form({
      username: '', name: 'x', password: 'x', role: 'agent',
    }))).rejects.toThrow();
  });
});

describe('removePartnerStaffAction', () => {
  it('deletes the staff record and all their sessions', async () => {
    const authStore = createAuthStore(redis);
    await authStore.saveStaff({
      username: 'p1', name: 'P', role: 'agent',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p1');

    await removePartnerStaffAction(form({ username: 'p1' }));

    expect(await authStore.getStaff('p1')).toBeNull();
    expect(await authStore.getSessionUser(token)).toBeNull();
  });
});
