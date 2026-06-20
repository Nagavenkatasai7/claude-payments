/**
 * Remove the self-provisioned "E2E Smoke Partner" rows so the demo partners list
 * is clean. The post-deploy smoke FIND-OR-CREATEs this partner on EVERY deploy,
 * so run this AFTER the final deploy's smoke run (and don't redeploy after).
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/clean-smoke-partner.ts
 *
 * SAFE: only deletes partners named exactly 'E2E Smoke Partner' that have ZERO
 * transfers and ZERO customers (a real partner is never touched). FK-ordered.
 * NOTE: the partner-scoped staff `e2e-smoke-partner` lives in Redis (Vercel-only)
 * and is NOT removed here — remove it via the dashboard Team → Remove if needed;
 * the next smoke run's self-heal recreates it bound to a fresh partner anyway.
 */
import { getDb } from '@/db/client';
import { sql } from 'drizzle-orm';

const SMOKE_NAME = 'E2E Smoke Partner';

async function main() {
  const db = getDb();

  const targets = ((await db.execute(sql`
    SELECT p.id, p.name,
      (SELECT count(*) FROM transfers t WHERE t.partner_id = p.id)::int AS transfers,
      (SELECT count(*) FROM customers c WHERE c.partner_id = p.id)::int AS customers
    FROM partners p
    WHERE p.name = ${SMOKE_NAME}
  `)) as unknown as { rows: Array<{ id: string; name: string; transfers: number; customers: number }> }).rows;

  if (targets.length === 0) {
    console.log('No "E2E Smoke Partner" found — nothing to clean.');
    return;
  }

  for (const t of targets) {
    if (t.transfers > 0 || t.customers > 0) {
      console.log(`  ⚠ skip ${t.id} — has ${t.transfers} transfers / ${t.customers} customers (NOT a disposable smoke row)`);
      continue;
    }
    // FK-ordered: children first, then the partner row.
    await db.execute(sql`DELETE FROM partner_rates WHERE partner_id = ${t.id}`);
    await db.execute(sql`DELETE FROM api_keys WHERE partner_id = ${t.id}`);
    await db.execute(sql`DELETE FROM partner_integrations WHERE partner_id = ${t.id}`);
    await db.execute(sql`DELETE FROM partners WHERE id = ${t.id}`);
    console.log(`  ✓ removed smoke partner ${t.id} (${t.name})`);
  }

  const remaining = ((await db.execute(sql`SELECT id, name FROM partners ORDER BY name`)) as unknown as {
    rows: Array<{ id: string; name: string }>;
  }).rows;
  console.log(`\nPartners now (${remaining.length}):`);
  for (const p of remaining) console.log(`  ${p.id.padEnd(12)} ${p.name}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('clean-smoke failed:', e); process.exit(1); });
