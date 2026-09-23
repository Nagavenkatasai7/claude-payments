import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Program-Fix 45 P5: the app's store (getAuthStore) carries the Postgres staff
// ledger, resolved on FIRST USE, and a database that cannot be reached
// degrades reads to the Redis record instead of signing staff out.

const redis = fakeRedis();
const h = vi.hoisted(() => ({ db: null as unknown, dbThrows: false, getDbCalls: 0 }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<object>()),
  getDb: () => {
    h.getDbCalls++;
    if (h.dbThrows) throw new Error('Missing required environment variable: DATABASE_URL');
    return h.db;
  },
}));

const member: Staff = {
  username: 'priya',
  name: 'Priya',
  role: 'agent',
  permissions: { canCancel: false, canResend: true, canAssign: false },
  passwordHash: 'h',
  createdAt: '2026-09-01T10:00:00.000Z',
};

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  h.db = db;
  h.dbThrows = false;
  h.getDbCalls = 0;
  redis.dump.clear();
  vi.resetModules();
});

describe('getAuthStore wires the staff ledger (Program-Fix 45 P5)', () => {
  it('does not touch the database until a staff call needs it', async () => {
    const { getAuthStore } = await import('@/lib/auth-store');
    const store = getAuthStore();
    expect(h.getDbCalls).toBe(0);
    await store.createSession('priya');
    expect(h.getDbCalls).toBe(0);
  });

  it('saveStaff lands in the ledger table', async () => {
    const { getAuthStore } = await import('@/lib/auth-store');
    const { createStaffRepo } = await import('@/db/repos/staff-repo');
    await getAuthStore().saveStaff(member);
    expect((await createStaffRepo(db).get('priya'))?.name).toBe('Priya');
  });

  it('an unreachable database degrades reads to the Redis record', async () => {
    h.dbThrows = true;
    await redis.set('staff:priya', JSON.stringify(member));
    await redis.sadd('staff:index', 'priya');
    const { getAuthStore } = await import('@/lib/auth-store');
    expect((await getAuthStore().getStaff('priya'))?.role).toBe('agent');
    expect((await getAuthStore().listStaff()).length).toBe(1);
  });
});
