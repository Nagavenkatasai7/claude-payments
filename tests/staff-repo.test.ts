import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createStaffRepo } from '@/db/repos/staff-repo';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Program-Fix 45 P5 (crypto-03): the staff ledger table, on the REAL drizzle
// migration chain (PGlite runs every drizzle/*.sql, 0022 included).

function member(over: Partial<Staff> = {}): Staff {
  return {
    username: 'priya',
    name: 'Priya',
    role: 'agent',
    permissions: { canCancel: false, canResend: true, canAssign: false },
    passwordHash: '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...over,
  };
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

describe('staff-repo (migration 0022)', () => {
  it('upsert then get round-trips every field (status absent reads back active)', async () => {
    const repo = createStaffRepo(db);
    await repo.upsert(member({ lastLoginAt: '2026-09-02T11:00:00.000Z' }));
    expect(await repo.get('priya')).toEqual({
      ...member(),
      status: 'active',
      lastLoginAt: '2026-09-02T11:00:00.000Z',
    });
  });

  it('get returns null for an unknown username', async () => {
    expect(await createStaffRepo(db).get('nobody')).toBeNull();
  });

  it('keeps partner scope and the optional canRevealPii flag', async () => {
    await seedPartner(db, 'p_acme');
    const repo = createStaffRepo(db);
    await repo.upsert(member({ partnerId: 'p_acme', permissions: { canCancel: true, canResend: false, canAssign: true, canRevealPii: true } }));
    const got = await repo.get('priya');
    expect(got?.partnerId).toBe('p_acme');
    expect(got?.permissions).toEqual({ canCancel: true, canResend: false, canAssign: true, canRevealPii: true });
  });

  it('upsert overwrites an existing row (the app write path)', async () => {
    const repo = createStaffRepo(db);
    await repo.upsert(member());
    await repo.upsert(member({ role: 'support', status: 'suspended', name: 'P' }));
    const got = await repo.get('priya');
    expect(got?.role).toBe('support');
    expect(got?.status).toBe('suspended');
    expect(got?.name).toBe('P');
  });

  it('insertIfMissing never overwrites an existing row (copy-on-read)', async () => {
    const repo = createStaffRepo(db);
    await repo.upsert(member({ status: 'suspended' }));
    await repo.insertIfMissing([member({ status: 'active', role: 'admin' })]);
    const got = await repo.get('priya');
    expect(got?.status).toBe('suspended');
    expect(got?.role).toBe('agent');
  });

  it('insertIfMissing inserts several missing rows and tolerates an empty list', async () => {
    const repo = createStaffRepo(db);
    await repo.insertIfMissing([]);
    await repo.insertIfMissing([member(), member({ username: 'ravi' })]);
    expect((await repo.getMany(['priya', 'ravi', 'ghost'])).size).toBe(2);
  });

  it('getMany returns a map keyed by username (one query; empty input → empty map)', async () => {
    const repo = createStaffRepo(db);
    expect((await repo.getMany([])).size).toBe(0);
    await repo.upsert(member());
    const m = await repo.getMany(['priya']);
    expect(m.get('priya')?.name).toBe('Priya');
  });

  it('remove deletes the row', async () => {
    const repo = createStaffRepo(db);
    await repo.upsert(member());
    await repo.remove('priya');
    expect(await repo.get('priya')).toBeNull();
  });

  it('setLastLogin and setPasswordHash touch only their column', async () => {
    const repo = createStaffRepo(db);
    await repo.upsert(member({ status: 'suspended' }));
    await repo.setLastLogin('priya', '2026-09-03T09:00:00.000Z');
    await repo.setPasswordHash('priya', 'new-hash');
    const got = await repo.get('priya');
    expect(got?.lastLoginAt).toBe('2026-09-03T09:00:00.000Z');
    expect(got?.passwordHash).toBe('new-hash');
    expect(got?.status).toBe('suspended');
  });

  it('the table refuses an unknown role or status and a partner that does not exist', async () => {
    const repo = createStaffRepo(db);
    await expect(repo.upsert(member({ role: 'root' as Staff['role'] }))).rejects.toThrow();
    await expect(repo.upsert(member({ status: 'banned' as Staff['status'] }))).rejects.toThrow();
    await expect(repo.upsert(member({ partnerId: 'p_missing' }))).rejects.toThrow();
  });

  it('migration 0022 created the table with the expected columns', async () => {
    const rows = await db.execute(
      sql.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'staff' ORDER BY column_name`),
    );
    const cols = (rows as unknown as { rows: Array<{ column_name: string }> }).rows.map((r) => r.column_name);
    expect(cols).toEqual([
      'created_at',
      'last_login_at',
      'name',
      'partner_id',
      'password_hash',
      'permissions',
      'role',
      'status',
      'updated_at',
      'username',
    ]);
  });
});
