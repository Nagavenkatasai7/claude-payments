import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStaffRepo } from '@/db/repos/staff-repo';
import { createAuthStore } from '@/lib/auth-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-6: creating a finance account is IMPOSSIBLE until the M3-7 migration (0028) adds
// 'finance' to staff_role_check. The ledger CHECK (schema.ts staff_role_check) refuses the row,
// and createStaff releases its Redis claim, so no half-created finance member exists.
// M3-7 flips this test to "accepts" in the same PR as the CHECK change.
let db: Db;
const finance = (): Staff => ({
  username: 'fin1',
  name: 'F',
  role: 'finance' as Staff['role'],
  permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
  passwordHash: 'h',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'pa',
});

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
});

describe('finance is fail-closed at the ledger until the M3-7 migration', () => {
  it('createStaffRepo(db).upsert(finance) is rejected by the CHECK', async () => {
    await expect(createStaffRepo(db).upsert(finance())).rejects.toThrow();
    expect(await createStaffRepo(db).get('fin1')).toBeNull();
  });
  it('createAuthStore(redis, { ledger }).createStaff(finance) throws and leaves no Redis record', async () => {
    const redis = fakeRedis();
    const store = createAuthStore(redis, { ledger: () => createStaffRepo(db) });
    await expect(store.createStaff(finance())).rejects.toThrow('staff ledger write failed');
    expect(redis.dump.has('staff:fin1')).toBe(false);
    expect(await redis.smembers('staff:index')).not.toContain('fin1');
    expect(await store.getStaff('fin1')).toBeNull();
  });
  it('saveStaff(finance) throws before Redis changes', async () => {
    const redis = fakeRedis();
    const store = createAuthStore(redis, { ledger: () => createStaffRepo(db) });
    await expect(store.saveStaff(finance())).rejects.toThrow('staff ledger write failed');
    expect(redis.dump.has('staff:fin1')).toBe(false);
  });
});
