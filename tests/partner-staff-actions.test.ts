import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

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
// Program-Fix 17b: creating/removing a member clears its MFA keys.
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
// Partner store is Postgres-backed now; rebuilt from a fresh PGlite per test.
// The vi.mock factory closes over the let-variable (assigned in beforeEach).
let db: Db;
let ps: import('@/lib/partner-store').PartnerStore;
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => ps };
});
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Program-Fix 17a: createPartnerStaffAction runs the staff password policy
// (breach check fail-closed). Never dial HIBP from a unit test.
const pwnedStatus = vi.hoisted(() => vi.fn(async (_pw: string): Promise<'pwned' | 'clean' | 'unavailable'> => 'clean'));
vi.mock('@/lib/pwned', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pwned')>('@/lib/pwned');
  return { ...actual, pwnedPasswordStatus: pwnedStatus };
});

import { createPartnerStaffAction, removePartnerStaffAction } from '@/app/admin-dashboard/partners/actions';
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerStore } from '@/lib/partner-store';

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  ps = createPartnerStore(db);
  // Seed the 'acme' partner that every createPartnerStaffAction test references.
  await seedPartner(db, 'acme', 'Acme');
});
afterEach(() => vi.clearAllMocks());

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe('createPartnerStaffAction', () => {
  it('creates a staff record scoped to the given partnerId from the URL', async () => {
    await createPartnerStaffAction('acme', form({
      username: 'p1', name: 'Partner One', password: 'partner-one-password', role: 'admin',
    }));
    const got = await createAuthStore(redis).getStaff('p1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
    expect(got?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('refuses to honour partnerId from the form (URL param is authoritative)', async () => {
    // The form might try to override partnerId; we ignore it.
    await createPartnerStaffAction('acme', form({
      username: 'p2', name: 'P Two', password: 'partner-two-password', role: 'agent',
      partnerId: 'OVERRIDE',
    }));
    const got = await createAuthStore(redis).getStaff('p2');
    expect(got?.partnerId).toBe('acme');
  });

  it('Program-Fix 17a: refuses a short or breached password, and an HIBP outage (fail-closed), without writing', async () => {
    await expect(createPartnerStaffAction('acme', form({
      username: 'p3', name: 'P3', password: 'hunter2', role: 'agent',
    }))).rejects.toThrow(/12 characters/);
    pwnedStatus.mockImplementationOnce(async () => 'pwned');
    await expect(createPartnerStaffAction('acme', form({
      username: 'p3', name: 'P3', password: 'partner-three-password', role: 'agent',
    }))).rejects.toThrow(/breach/);
    pwnedStatus.mockImplementationOnce(async () => 'unavailable');
    await expect(createPartnerStaffAction('acme', form({
      username: 'p3', name: 'P3', password: 'partner-three-password', role: 'agent',
    }))).rejects.toThrow(/unavailable/i);
    expect(await createAuthStore(redis).getStaff('p3')).toBeNull();
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

  it('throws when the partner does not exist', async () => {
    await expect(createPartnerStaffAction('ghost', form({
      username: 'p1', name: 'P', password: 'pw', role: 'agent',
    }))).rejects.toThrow(/partner not found/i);
  });

  it('refuses to clobber an existing staff record (silent overwrite would let a platform admin hijack any account)', async () => {
    // Seed a pre-existing platform admin
    await createAuthStore(redis).saveStaff({
      username: 'admin', name: 'Admin', role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: 'pre:existing', createdAt: '2026-01-01T00:00:00Z',
    });
    await expect(createPartnerStaffAction('acme', form({
      username: 'admin', name: 'New', password: 'pw', role: 'agent',
    }))).rejects.toThrow(/already exists/i);
    // Verify the original record is intact (no silent rebind)
    const orig = await createAuthStore(redis).getStaff('admin');
    expect(orig?.partnerId).toBeUndefined();
    expect(orig?.passwordHash).toBe('pre:existing');
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
