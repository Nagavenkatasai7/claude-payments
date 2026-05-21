import { describe, it, expect } from 'vitest';
import { ensureSeedAdmin } from '@/lib/seed';
import { createAuthStore } from '@/lib/auth-store';
import { verifyPassword } from '@/lib/password';
import { fakeRedis } from './helpers';

describe('ensureSeedAdmin', () => {
  it('creates an admin from env when no staff exist', async () => {
    const store = createAuthStore(fakeRedis());
    await ensureSeedAdmin(store);
    const admin = await store.getStaff('admin'); // SEED_ADMIN_USERNAME in tests/setup.ts
    expect(admin?.role).toBe('admin');
    expect(verifyPassword('admin-test-pw', admin!.passwordHash)).toBe(true);
  });

  it('does nothing when staff already exist', async () => {
    const store = createAuthStore(fakeRedis());
    await ensureSeedAdmin(store);
    await ensureSeedAdmin(store);
    expect(await store.listStaff()).toHaveLength(1);
  });
});
