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
import { LEASE_MS, createOutboxRepo } from '@/db/repos/outbox-repo';
import { cadenceRedis, readLastCronAt, CRON_QUIET_MINUTES, DRAIN_SLA_MINUTES } from '@/lib/worker-cadence';
import { WORKER_BACKSTOP_PERIOD_MIN } from '@/lib/worker-gate';
import { scrub } from '@/lib/log';

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

  // Lease-inclusive (fix 12): the same predicate claimBatch uses, so this line and
  // the worker's draingap alarm can never disagree (due pending/failed + expired leases).
  const dueSummary = await createOutboxRepo(db).dueSummary();
  const oldestWaitMin = dueSummary.oldestDueAt
    ? Math.round((Date.now() - dueSummary.oldestDueAt.getTime()) / 60_000)
    : null;
  const drainBehind = oldestWaitMin !== null && oldestWaitMin > DRAIN_SLA_MINUTES;
  section(
    `DUE backlog (claimable by the next drain, incl. expired leases — SLA ${DRAIN_SLA_MINUTES}m; work the gate was not told about waits ≤${WORKER_BACKSTOP_PERIOD_MIN}m for the backstop${drainBehind ? ' — BEHIND' : ''})`,
    dueSummary.dueNow === 0
      ? []
      : [{ due_now: dueSummary.dueNow, oldest_due: dueSummary.oldestDueAt?.toISOString(), oldest_wait_min: oldestWaitMin }],
  );

  // fix 12: the Vercel per-minute cron's last recorded run (Redis marker,
  // src/lib/worker-cadence.ts). Absent ⇒ the cron has never reached this
  // deployment (or Redis is unreachable) — counted as needing a human, like a
  // quiet marker. KV vars missing from .env.local must not block this report.
  let lastCronAt: Date | null = null;
  let cronNote = '';
  try {
    lastCronAt = await readLastCronAt(cadenceRedis());
  } catch (e) {
    cronNote = ` (redis unavailable: ${scrub(e instanceof Error ? e.message : String(e))})`;
  }
  const lastCronMin = lastCronAt ? Math.round((Date.now() - lastCronAt.getTime()) / 60_000) : null;
  const cronQuiet = lastCronMin === null || lastCronMin > CRON_QUIET_MINUTES;
  console.log(`\nLAST CRON RUN (Vercel /api/worker every minute — touches the DB only when work is marked due or on the :17/:47 backstop; quiet >${CRON_QUIET_MINUTES}m)`);
  console.log(
    lastCronAt
      ? `  ${lastCronAt.toISOString()} — ${lastCronMin}m ago${cronQuiet ? ' — QUIET' : ''}`
      : `  none — no marker${cronNote}`,
  );

  const openByKind = await q(sql`
    SELECT kind, status, count(*)::int AS n
    FROM outbox WHERE status IN ('pending','failed','processing','dead')
    GROUP BY kind, status ORDER BY kind, status`);
  section('OPEN rows by kind', openByKind, 'nothing open');

  const dead = await q(sql`
    SELECT id, kind, attempts, left(coalesce(last_error, ''), 160) AS last_error, created_at
    FROM outbox WHERE status = 'dead' ORDER BY created_at DESC LIMIT 20`);
  section('DEAD rows (never auto-retry — admin-dashboard/ops → Retry)', dead);

  // Effective lease: lease_until, or locked_at + LEASE_MS for rows claimed by
  // pre-lease code (lease_until NULL) — the same expression claimBatch uses.
  const leaseSec = LEASE_MS / 1000;
  const expiredLeases = await q(sql`
    SELECT count(*)::int AS reclaimable,
           min(coalesce(lease_until, locked_at + make_interval(secs => ${leaseSec}))) AS oldest_lease
    FROM outbox
    WHERE status = 'processing' AND coalesce(lease_until, locked_at + make_interval(secs => ${leaseSec})) < now()`);
  section('EXPIRED leases (worker died mid-row — RECLAIMED by the next drain, attempts++)', expiredLeases);

  const staleLocks = await q(sql`
    SELECT id, kind, attempts, coalesce(lease_owner, locked_by) AS owner,
           coalesce(lease_until, locked_at + make_interval(secs => ${leaseSec})) AS lease_until
    FROM outbox
    WHERE status = 'processing'
      AND coalesce(lease_until, locked_at + make_interval(secs => ${leaseSec})) < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
    ORDER BY 5 LIMIT 20`);
  section(`STALE locks (lease expired >${STALE_LOCK_MINUTES}m and NOT reclaimed — the drain is not running; check the Vercel cron (Settings → Cron Jobs) and worker-heartbeat.yml)`, staleLocks);

  // Rows claimed by PRE-0014 code (never leased). Informational: claimBatch and the
  // stale-lock sweep treat them as leased until locked_at + LEASE_MS, so they are
  // reclaimed automatically; this list should drain to empty after the deploy settles.
  const unleased = await q(sql`
    SELECT id, kind, attempts, locked_by, locked_at
    FROM outbox WHERE status = 'processing' AND lease_until IS NULL
    ORDER BY locked_at LIMIT 20`);
  section('UNLEASED processing rows (claimed by pre-lease code — implied lease locked_at + 5m, reclaimed automatically)', unleased);

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

  // fix 11: secrets that pre-fix releases copied into payloads. COUNTS ONLY —
  // the payload itself is never selected. The 0016 gate: before /migrate-prod
  // every row here must be done or dead (0016 leaves an UNSENT unresolvable
  // legacy row untouched — it would survive the scrub); after the apply this
  // must print "none". Since Program-Fix 12 (second PR) the worker has no shim
  // for such a row: it fails closed (legacy_creds_payload), dead-letters and
  // alerts, and, when `creds` is an object, stays counted here; any other
  // non-null `creds` shows only in DEAD rows with `last_error =
  // legacy_creds_payload`. A row here now means a regressed producer or a
  // survivor to scrub by hand. The query is the PGlite-tested
  // outboxRepo.listSecretsAtRest (tests/outbox-payload-secrets.test.ts): it tests
  // a VALUE, not a key, so a `"creds": null` row never blocks the gate.
  const secretsAtRest: Row[] = await createOutboxRepo(db).listSecretsAtRest();
  section('SECRETS AT REST (fix 11: legacy creds / cleartext invite links — must be none once drizzle 0016 is applied)', secretsAtRest);

  const needsHuman =
    dead.length + staleLocks.length + stuckPaid.length + staleReview.length + pendingRefunds.length +
    secretsAtRest.length + (cronQuiet ? 1 : 0) + (drainBehind ? 1 : 0);
  console.log(`\nSUMMARY: ${needsHuman === 0 ? 'nothing needs a human' : `${needsHuman} row(s) need a human — see sections above`}\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('outbox-status failed:', e); process.exit(1); });
