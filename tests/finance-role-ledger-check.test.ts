import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStaffRepo } from '@/db/repos/staff-repo';
import { createAuthStore } from '@/lib/auth-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-6 + M3-7: migration 0028 adds 'finance' to staff_role_check, so the LEDGER now
// accepts a finance row (flipped here in M3-7). Creating one through the app stays refused by the
// role allowlists on every create path (team/partners actions, partner-staff-policy; pinned in the
// M3-6 suites) until M3-8 adds the finance create path. Unknown roles are still refused by the CHECK.
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

describe('the ledger accepts finance after 0028; unknown roles stay refused', () => {
  it('createStaffRepo(db).upsert(finance) is accepted and reads back as finance', async () => {
    await createStaffRepo(db).upsert(finance());
    expect((await createStaffRepo(db).get('fin1'))?.role).toBe('finance');
  });
  it('an unknown role is still rejected by the CHECK', async () => {
    await expect(createStaffRepo(db).upsert({ ...finance(), username: 'x1', role: 'root' as Staff['role'] })).rejects.toThrow();
    expect(await createStaffRepo(db).get('x1')).toBeNull();
  });
  it('a finance member created through the store keeps all-false legacy permissions', async () => {
    const redis = fakeRedis();
    const store = createAuthStore(redis, { ledger: () => createStaffRepo(db) });
    await store.createStaff({ ...finance(), permissions: { canCancel: true, canResend: true, canAssign: true, canRevealPii: true } });
    const got = await store.getStaff('fin1');
    expect(got?.role).toBe('finance');
    expect(got?.permissions).toEqual({ canCancel: false, canResend: false, canAssign: false, canRevealPii: false });
  });
});
