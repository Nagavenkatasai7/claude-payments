/**
 * READ-ONLY: which drizzle journal tags are applied on the target database.
 * Compares drizzle/meta/_journal.json `when` with drizzle.__drizzle_migrations.created_at
 * (drizzle-kit migrate stores the journal timestamp there). Optional
 * --check "<SELECT …>" runs ONE read-only statement afterwards — /migrate-prod uses it
 * to prove an altered table answers after an apply.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migration-status.ts [--check "SELECT 1"]
 */
import { getDb } from '@/db/client';
import { compareMigrations, JOURNAL_ENTRIES, readAppliedMigrations } from '@/db/migration-status';
import { sql } from 'drizzle-orm';

type Row = Record<string, unknown>;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>): Promise<Row[]> =>
    ((await db.execute(s)) as unknown as { rows: Row[] }).rows;

  let applied: unknown[] = [];
  try {
    applied = await readAppliedMigrations(db);
  } catch (e) {
    console.error('drizzle.__drizzle_migrations is not readable (fresh database?):', (e as Error).message);
  }
  // Same rule as GET /api/version/migrations (src/db/migration-status.ts).
  const status = compareMigrations(JOURNAL_ENTRIES, applied);
  const pendingTags = new Set(status.pending);
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();

  console.log(`\nMigration status against ${host}\n`);
  for (const e of JOURNAL_ENTRIES) {
    console.log(`  ${pendingTags.has(e.tag) ? 'PENDING' : 'APPLIED'}  ${e.tag}`);
  }
  const extra = status.unknownApplied;
  if (extra.length > 0) {
    console.log(`\n  NOTE: ${extra.length} applied row(s) are not in the journal (created_at: ${extra.map((w) => String(w)).join(', ')}).`);
    console.log('  Journal and database have diverged — investigate before applying anything.');
  }
  const pending = status.pending.length;
  console.log(pending > 0 ? `\n${pending} PENDING — apply via /migrate-prod (approval-gated).` : '\nAll journal migrations are applied.');

  const i = process.argv.indexOf('--check');
  if (i > -1) {
    const stmt = (process.argv[i + 1] ?? '').trim();
    if (!/^select\b/i.test(stmt) || stmt.includes(';')) {
      throw new Error('--check accepts exactly one SELECT statement (no semicolons)');
    }
    console.log(`\n--check: ${stmt}`);
    console.table(await q(sql.raw(stmt)));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('migration-status failed:', e); process.exit(1); });
