import { eq, inArray, sql } from 'drizzle-orm';
import { staff } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { Staff, StaffPermissions, StaffRole, StaffStatus } from '@/lib/types';

// staff-repo — Program-Fix 45 P5 (crypto-03, migration 0022). The Postgres
// half of the staff dual-write. auth-store is the ONLY caller: it decides what
// a row means (during the dual-write release a row can only restrict the Redis
// record, see mergeStaffRecords in auth-store.ts). Server-only: rows carry
// password_hash, so nothing here may reach a client component.

type StaffRow = typeof staff.$inferSelect;

function rowToStaff(row: StaffRow): Staff {
  const s: Staff = {
    username: row.username,
    name: row.name,
    role: row.role as StaffRole,
    permissions: row.permissions as StaffPermissions,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt.toISOString(),
    status: row.status as StaffStatus,
  };
  if (row.partnerId) s.partnerId = row.partnerId;
  if (row.lastLoginAt) s.lastLoginAt = row.lastLoginAt.toISOString();
  return s;
}

function staffToRow(s: Staff): typeof staff.$inferInsert {
  return {
    username: s.username,
    partnerId: s.partnerId ?? null,
    name: s.name,
    role: s.role,
    permissions: s.permissions,
    passwordHash: s.passwordHash,
    status: s.status ?? 'active',
    createdAt: new Date(s.createdAt),
    lastLoginAt: s.lastLoginAt ? new Date(s.lastLoginAt) : null,
  };
}

export function createStaffRepo(db: DbOrTx) {
  return {
    async get(username: string): Promise<Staff | null> {
      const rows = await db.select().from(staff).where(eq(staff.username, username)).limit(1);
      return rows[0] ? rowToStaff(rows[0]) : null;
    },

    /** One query for many usernames (listStaff). */
    async getMany(usernames: string[]): Promise<Map<string, Staff>> {
      const out = new Map<string, Staff>();
      if (usernames.length === 0) return out;
      const rows = await db.select().from(staff).where(inArray(staff.username, usernames));
      for (const r of rows) out.set(r.username, rowToStaff(r));
      return out;
    },

    /** The app write path (create, edit, suspend, reactivate, seed): the whole row. */
    async upsert(s: Staff): Promise<void> {
      const row = staffToRow(s);
      const { username: _pk, ...rest } = row;
      await db
        .insert(staff)
        .values(row)
        .onConflictDoUpdate({ target: staff.username, set: { ...rest, updatedAt: sql`now()` } });
    },

    /**
     * Copy-on-read: inserts the rows that do not exist yet and NEVER touches
     * one that does, so a read can never relax (or otherwise rewrite) a row.
     */
    async insertIfMissing(records: Staff[]): Promise<void> {
      if (records.length === 0) return;
      await db.insert(staff).values(records.map(staffToRow)).onConflictDoNothing({ target: staff.username });
    },

    async remove(username: string): Promise<void> {
      await db.delete(staff).where(eq(staff.username, username));
    },

    /** Mirror of auth-store.recordLogin (lastLoginAt only). */
    async setLastLogin(username: string, iso: string): Promise<void> {
      await db
        .update(staff)
        .set({ lastLoginAt: new Date(iso), updatedAt: sql`now()` })
        .where(eq(staff.username, username));
    },

    /** Mirror of a password write that Redis already accepted (not read in this release). */
    async setPasswordHash(username: string, hash: string): Promise<void> {
      await db
        .update(staff)
        .set({ passwordHash: hash, updatedAt: sql`now()` })
        .where(eq(staff.username, username));
    },
  };
}

export type StaffRepo = ReturnType<typeof createStaffRepo>;
