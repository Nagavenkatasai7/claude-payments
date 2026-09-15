/**
 * READ-ONLY: which drizzle journal tags are applied on the target database.
 * Compares drizzle/meta/_journal.json `when` with drizzle.__drizzle_migrations.created_at
 * (drizzle-kit migrate stores the journal timestamp there). Optional
 * --check "<SELECT …>" runs ONE read-only statement afterwards — /migrate-prod uses it
 * to prove an altered table answers after an apply.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migration-status.ts [--check "SELECT 1"]
 */
import { readFileSync } from 'node:fs';
import { getDb } from '@/db/client';
import { sql } from 'drizzle-orm';

type Row = Record<string, unknown>;
type Journal = { entries: Array<{ idx: number; when: number; tag: string }> };

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>): Promise<Row[]> =>
    ((await db.execute(s)) as unknown as { rows: Row[] }).rows;

  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as Journal;
  let applied: Row[] = [];
  try {
    applied = await q(sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`);
  } catch (e) {
    console.error('drizzle.__drizzle_migrations is not readable (fresh database?):', (e as Error).message);
  }
  const appliedWhen = new Set(applied.map((r) => Number(r.created_at)));
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();

  console.log(`\nMigration status against ${host}\n`);
  let pending = 0;
  for (const e of journal.entries) {
    const ok = appliedWhen.has(e.when);
    if (!ok) pending++;
    console.log(`  ${ok ? 'APPLIED' : 'PENDING'}  ${e.tag}`);
  }
  const extra = applied.filter((r) => !journal.entries.some((e) => e.when === Number(r.created_at)));
  if (extra.length > 0) {
    console.log(`\n  NOTE: ${extra.length} applied row(s) are not in the journal (created_at: ${extra.map((r) => String(r.created_at)).join(', ')}).`);
    console.log('  Journal and database have diverged — investigate before applying anything.');
  }
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
