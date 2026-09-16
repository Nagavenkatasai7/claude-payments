/**
 * READ-ONLY snapshot of the durability outbox + stuck money on the target DB.
 * SELECTs only; prints no secret and no PII (ids, kinds, timestamps, trimmed errors).
 * Thresholds are IMPORTED from src/lib/reconcile.ts so this report and the sweep
 * can never disagree about what "stuck" means.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/outbox-status.ts
 */
import { getDb } from '@/db/client';
import { sql } from 'drizzle-orm';
import { STUCK_PAID_MINUTES, STALE_REVIEW_HOURS, STUCK_REFUND_MINUTES, STALE_LOCK_MINUTES } from '@/lib/reconcile';

type Row = Record<string, unknown>;

function section(title: string, rows: Row[], emptyMsg = 'none') {
  console.log(`\n${title}`);
  if (rows.length === 0) console.log(`  ${emptyMsg}`);
  else console.table(rows);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>): Promise<Row[]> =>
    ((await db.execute(s)) as unknown as { rows: Row[] }).rows;

  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();
  console.log(`\nOutbox status against ${host} — ${new Date().toISOString()}`);
  console.log(`thresholds (src/lib/reconcile.ts): stuck paid >${STUCK_PAID_MINUTES}m · stale review >${STALE_REVIEW_HOURS}h · stuck refund >${STUCK_REFUND_MINUTES}m · stale lock >${STALE_LOCK_MINUTES}m past lease`);

  const byStatus = await q(sql`
    SELECT status, count(*)::int AS n, max(attempts)::int AS max_attempts, min(created_at) AS oldest
    FROM outbox GROUP BY status ORDER BY status`);
  section('OUTBOX rows by status', byStatus, 'outbox is empty');

  const due = await q(sql`
    SELECT count(*)::int AS due_now, min(next_attempt_at) AS oldest_due
    FROM outbox WHERE status IN ('pending','failed') AND next_attempt_at <= now()`);
  section('DUE backlog (claimable by the next drain)', due);

  const openByKind = await q(sql`
    SELECT kind, status, count(*)::int AS n
    FROM outbox WHERE status IN ('pending','failed','processing','dead')
    GROUP BY kind, status ORDER BY kind, status`);
  section('OPEN rows by kind', openByKind, 'nothing open');

  const dead = await q(sql`
    SELECT id, kind, attempts, left(coalesce(last_error, ''), 160) AS last_error, created_at
    FROM outbox WHERE status = 'dead' ORDER BY created_at DESC LIMIT 20`);
  section('DEAD rows (never auto-retry — admin-dashboard/ops → Retry)', dead);

  const expiredLeases = await q(sql`
    SELECT count(*)::int AS reclaimable, min(lease_until) AS oldest_lease
    FROM outbox WHERE status = 'processing' AND lease_until < now()`);
  section('EXPIRED leases (worker died mid-row — RECLAIMED by the next drain, attempts++)', expiredLeases);

  const staleLocks = await q(sql`
    SELECT id, kind, attempts, lease_owner, lease_until
    FROM outbox
    WHERE status = 'processing' AND lease_until < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
    ORDER BY lease_until LIMIT 20`);
  section(`STALE locks (lease expired >${STALE_LOCK_MINUTES}m and NOT reclaimed — the drain is not running; check worker-heartbeat.yml)`, staleLocks);

  // Rows claimed by PRE-0014 code (never leased): the reclaim disjunct and staleLocks
  // both compare lease_until < now(), which never matches NULL — invisible + unreclaimable
  // until the Step 7.10.3 backfill UPDATE is re-run. Must read 0 after the deploy settles.
  const unleased = await q(sql`
    SELECT id, kind, attempts, locked_by, locked_at
    FROM outbox WHERE status = 'processing' AND lease_until IS NULL
    ORDER BY locked_at LIMIT 20`);
  section('UNLEASED processing rows (claimed by pre-lease code — re-run the 7.10.3 backfill UPDATE)', unleased);

  const stuckPaid = await q(sql`
    SELECT id, partner_id, paid_at, refund_status
    FROM transfers
    WHERE status = 'paid' AND refund_status = 'none'
      AND paid_at < now() - make_interval(mins => ${STUCK_PAID_MINUTES})
    ORDER BY paid_at LIMIT 20`);
  section(`STUCK PAID (>${STUCK_PAID_MINUTES}m, no delivery confirmation — reconcile re-instructs once + alerts)`, stuckPaid);

  const staleReview = await q(sql`
    SELECT id, partner_id, paid_at
    FROM transfers
    WHERE status = 'in_review' AND paid_at < now() - make_interval(hours => ${STALE_REVIEW_HOURS})
    ORDER BY paid_at LIMIT 20`);
  section(`STALE REVIEWS (>${STALE_REVIEW_HOURS}h in compliance hold — release or refund)`, staleReview);

  const pendingRefunds = await q(sql`
    SELECT t.id, t.partner_id, t.refund_status,
           (SELECT max(o.created_at) FROM outbox o
             WHERE o.kind = 'funding.refund' AND o.payload->>'transferId' = t.id) AS last_refund_effect_at
    FROM transfers t WHERE t.refund_status = 'pending' ORDER BY t.paid_at LIMIT 20`);
  section(`PENDING REFUNDS (stuck if last_refund_effect_at is null or older than ${STUCK_REFUND_MINUTES}m)`, pendingRefunds);

  const needsHuman =
    dead.length + staleLocks.length + unleased.length + stuckPaid.length + staleReview.length + pendingRefunds.length;
  console.log(`\nSUMMARY: ${needsHuman === 0 ? 'nothing needs a human' : `${needsHuman} row(s) need a human — see sections above`}\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('outbox-status failed:', e); process.exit(1); });
