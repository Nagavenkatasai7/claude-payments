import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

const redis = fakeRedis();
const envOverrides: Record<string, string> = {};
vi.mock('@/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'seedAdminUsername') return envOverrides.SEED_ADMIN_USERNAME ?? 'admin';
      if (prop === 'seedAdminPassword') return envOverrides.SEED_ADMIN_PASSWORD ?? 'pw';
      if (prop === 'seedPartnerUsername') return envOverrides.SEED_PARTNER_USERNAME ?? '';
      if (prop === 'seedPartnerPassword') return envOverrides.SEED_PARTNER_PASSWORD ?? '';
      if (prop === 'seedPartnerId') return envOverrides.SEED_PARTNER_ID ?? '';
      return '';
    },
  }),
}));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(redis) };
});

import { ensureSeedAdmin } from '@/lib/seed';
import { createAuthStore } from '@/lib/auth-store';
import { verifyPassword } from '@/lib/password';

beforeEach(() => {
  redis.dump.clear();
  for (const k of Object.keys(envOverrides)) delete envOverrides[k];
});
afterEach(() => vi.clearAllMocks());

describe('ensureSeedAdmin', () => {
  it('creates an admin from env when no staff exist', async () => {
    envOverrides.SEED_ADMIN_PASSWORD = 'admin-test-pw';
    await ensureSeedAdmin();
    const admin = await createAuthStore(redis).getStaff('admin');
    expect(admin?.role).toBe('admin');
    expect(verifyPassword('admin-test-pw', admin!.passwordHash)).toBe(true);
  });

  it('does nothing when staff already exist', async () => {
    await ensureSeedAdmin();
    await ensureSeedAdmin();
    expect(await createAuthStore(redis).listStaff()).toHaveLength(1);
  });

  it('seeds the platform admin when no staff exist', async () => {
    await ensureSeedAdmin();
    const got = await createAuthStore(redis).getStaff('admin');
    expect(got?.role).toBe('admin');
    expect(got?.partnerId).toBeUndefined();
  });

  it('also seeds a partner staff when partner-seed env vars are set', async () => {
    envOverrides.SEED_PARTNER_USERNAME = 'p1';
    envOverrides.SEED_PARTNER_PASSWORD = 'hunter2';
    envOverrides.SEED_PARTNER_ID = 'acme';
    await ensureSeedAdmin();
    const got = await createAuthStore(redis).getStaff('p1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
  });

  it('is idempotent on the partner-staff branch', async () => {
    envOverrides.SEED_PARTNER_USERNAME = 'p1';
    envOverrides.SEED_PARTNER_PASSWORD = 'hunter2';
    envOverrides.SEED_PARTNER_ID = 'acme';
    await ensureSeedAdmin();
    await ensureSeedAdmin();          // second call no-ops
    const all = await createAuthStore(redis).listStaff();
    expect(all.filter((s) => s.username === 'p1')).toHaveLength(1);
  });
});
