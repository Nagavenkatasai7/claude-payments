/**
 * Remove the self-provisioned "E2E Smoke Partner" rows so the demo partners list
 * is clean. The post-deploy smoke FIND-OR-CREATEs this partner on EVERY deploy,
 * so run this AFTER the final deploy's smoke run (and don't redeploy after).
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/clean-smoke-partner.ts
 *
 * SAFE: only deletes partners named exactly 'E2E Smoke Partner' that have ZERO
 * transfers, ZERO customers, ZERO conversation_messages rows and ZERO
 * rail_messages rows as owner or rail (fix pack 5: append-only, its DELETE
 * trigger refuses, and its FK blocks the partner delete). A real partner is
 * never touched; the sealed conversation log and the rail record are never
 * deleted. Fix pack 7: the same for the append-only hold decision record
 * (hold_reviews; its DELETE trigger refuses and its FK blocks the partner
 * delete): a smoke partner with any review is skipped. FK-ordered,
 * and ONE transaction (Program-Fix 45 P5): a refusal part-way commits nothing.
 * Program-Fix 45 P5: the partner's rows in the Postgres staff ledger (0022,
 * FK to partners) are deleted first. The partner-scoped staff
 * `e2e-smoke-partner` ALSO lives in Redis (Vercel-only) and is NOT removed
 * there; its ledger row is copied back in on the next read only if its
 * partner exists (the FK refuses otherwise, logged), and the next smoke run's
 * self-heal recreates it bound to a fresh partner anyway.
 */
import { getDb, type DbOrTx } from '@/db/client';
import { sql } from 'drizzle-orm';

export const SMOKE_PARTNER_NAME = 'E2E Smoke Partner';

export async function cleanSmokePartners(db: DbOrTx, log: (line: string) => void): Promise<void> {
  await db.transaction(async (tx) => {
    const targets = ((await tx.execute(sql`
      SELECT p.id, p.name,
        (SELECT count(*) FROM transfers t WHERE t.partner_id = p.id)::int AS transfers,
        (SELECT count(*) FROM customers c WHERE c.partner_id = p.id)::int AS customers,
        (SELECT count(*) FROM conversation_messages m WHERE m.partner_id = p.id)::int AS conversations,
        (SELECT count(*) FROM rail_messages r WHERE r.partner_id = p.id OR r.rail_partner_id = p.id)::int AS rail_messages,
        (SELECT count(*) FROM hold_reviews h WHERE h.partner_id = p.id)::int AS hold_reviews
      FROM partners p
      WHERE p.name = ${SMOKE_PARTNER_NAME}
    `)) as unknown as {
      rows: Array<{
        id: string;
        name: string;
        transfers: number;
        customers: number;
        conversations: number;
        rail_messages: number;
        hold_reviews: number;
      }>;
    }).rows;

    if (targets.length === 0) {
      log('No "E2E Smoke Partner" found — nothing to clean.');
      return;
    }

    for (const t of targets) {
      // Partner-Demo R3b: conversation_messages is a permanent, sealed audit
      // log — a partner with any row is never deleted (and the rows never are).
      // Fix pack 5: the same for the append-only rail record, as owner OR rail.
      // Fix pack 7: the same for the append-only hold decision record.
      if (t.transfers > 0 || t.customers > 0 || t.conversations > 0 || t.rail_messages > 0 || t.hold_reviews > 0) {
        log(
          `  ⚠ skip ${t.id} — has ${t.transfers} transfers / ${t.customers} customers / ${t.conversations} conversation messages / ${t.rail_messages} rail messages / ${t.hold_reviews} hold reviews (NOT a disposable smoke row)`,
        );
        continue;
      }
      // FK-ordered: children first, then the partner row.
      await tx.execute(sql`DELETE FROM staff WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partner_rates WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM api_keys WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partner_integrations WHERE partner_id = ${t.id}`);
      // UI redesign 0026-0028 children (partner site, portal settings, go-live, slug tombstones,
      // report jobs, webhook delivery log). After the 0028 backfill EVERY partner has a go-live row.
      await tx.execute(sql`DELETE FROM partner_sites WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partner_portal_settings WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partner_go_live WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partner_slug_tombstones WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partner_report_jobs WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partner_webhook_deliveries WHERE partner_id = ${t.id}`);
      // fix pack 8: destination register rows are config, never a skip reason.
      await tx.execute(sql`DELETE FROM partner_corridors WHERE partner_id = ${t.id}`);
      await tx.execute(sql`DELETE FROM partners WHERE id = ${t.id}`);
      log(`  ✓ removed smoke partner ${t.id} (${t.name})`);
    }
  });
}

async function main() {
  const db = getDb();
  await cleanSmokePartners(db, (l) => console.log(l));
  const remaining = ((await db.execute(sql`SELECT id, name FROM partners ORDER BY name`)) as unknown as {
    rows: Array<{ id: string; name: string }>;
  }).rows;
  console.log(`\nPartners now (${remaining.length}):`);
  for (const p of remaining) console.log(`  ${p.id.padEnd(12)} ${p.name}`);
}

if (process.argv[1]?.endsWith('clean-smoke-partner.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      // The error NAME only: a DrizzleQueryError message carries query params.
      console.error('clean-smoke failed:', e instanceof Error ? e.name : 'unknown error');
      process.exit(1);
    });
}
