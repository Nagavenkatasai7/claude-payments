import { sql } from 'drizzle-orm';
import journal from '../../drizzle/meta/_journal.json';
import type { DbOrTx } from '@/db/client';

// migration-status — has this database applied every migration the journal
// expects? Shared by GET /api/version/migrations (the post-deploy smoke's
// check) and scripts/migration-status.ts (the /migrate-prod read-out).
//
// The journal is imported, so the BUILD carries the list it was compiled
// with: the route answers for the code being served, not a checkout.
// A journal entry is applied when some drizzle.__drizzle_migrations row has
// created_at === entry.when: the drizzle migrator inserts the journal `when`
// as created_at (node_modules/drizzle-orm/migrator.js:22 folderMillis,
// pg-core/dialect.js:67).

export type JournalEntry = { idx: number; when: number; tag: string };

export const JOURNAL_ENTRIES: readonly JournalEntry[] = journal.entries;

export type MigrationComparison = {
  expected: number;
  applied: number;
  /** Journal tags with no applied row, in journal order. */
  pending: string[];
  /** created_at values applied but not in this journal (divergence, or a rollback to an older build). */
  unknownApplied: number[];
  /** Nothing pending. Unknown applied rows are reported, never fatal. */
  ok: boolean;
};

/** Pure compare. `appliedCreatedAt` may hold strings (Neon bigint), numbers or BigInts. */
export function compareMigrations(
  entries: readonly JournalEntry[],
  appliedCreatedAt: readonly unknown[],
): MigrationComparison {
  const applied = appliedCreatedAt.map((v) => Number(v));
  const appliedSet = new Set(applied);
  const known = new Set(entries.map((e) => e.when));
  const pending = entries.filter((e) => !appliedSet.has(e.when)).map((e) => e.tag);
  return {
    expected: entries.length,
    applied: entries.length - pending.length,
    pending,
    unknownApplied: applied.filter((w) => !known.has(w)),
    ok: pending.length === 0,
  };
}

/** created_at of every applied migration, oldest first. Errors propagate. */
export async function readAppliedMigrations(db: DbOrTx): Promise<unknown[]> {
  const res = await db.execute(sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`);
  return (res as unknown as { rows: Array<{ created_at: unknown }> }).rows.map((r) => r.created_at);
}
