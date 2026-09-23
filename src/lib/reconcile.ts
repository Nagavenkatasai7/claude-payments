import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { isSandbox, settleOrHold } from '@/lib/settlement';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { FIRST_RESPONSE_DUE_HOURS, slaDigestKey } from '@/lib/ticket-sla';
import { logWarn } from '@/lib/log';
import type { Transfer } from '@/lib/types';

// reconcile — the safety-net sweep (Stage 2d). Runs in every /api/worker
// invocation (per-minute Vercel cron, hourly GitHub heartbeat, poke), BEFORE the
// outbox drain so its effects drain in the same call. It catches the
// states the happy path can't lose silently anymore but an external party can
// still strand:
//   • a webhook-driven transfer stuck in 'paid' too long (the partner's rail
//     never called back, or the instruction died) → re-instruct ONCE + alert,
//   • a compliance hold ('in_review') nobody has touched in 24h → alert,
//   • a CHARGED transfer still awaiting_payment (fundingRef set; the process
//     died between capture and settleOrHold) → resume settlement (cleared) or
//     HOLD for review (flagged) + alert,
//   • cancelled + charged + unrefunded → alert (`cancelcharged:`),
//   • a refund in flight for over an hour → alert (ops decides; no auto-retry),
//   • a 'processing' lease expired >15m and still unreclaimed (the drain is down) → alert,
//   • customer tickets past their first-response target (fix 49C) → ONE digest a day.
// Every enqueue is dedupe-keyed per transfer, so the sweep firing every minute
// can never spam: one re-instruction and one alert per stuck transfer, ever.

export const STUCK_PAID_MINUTES = 15;
export const STALE_REVIEW_HOURS = 24;
export const FUNDING_RESUME_MINUTES = 10;
export const STUCK_REFUND_MINUTES = 60;
/**
 * A 'processing' row whose lease expired this long ago and is STILL unreclaimed.
 * claimBatch reclaims expired leases on every drain, so a survivor means the
 * drain is not running (cron / heartbeat / poke down) — alert per row, deduped.
 */
export const STALE_LOCK_MINUTES = 15;

export interface SweepResult {
  stuckPaid: number;
  reinstructed: number;
  staleReviews: number;
  // Optional ONLY so pre-existing zero-literals (the worker route's fallback)
  // stay assignable; reconcileSweep itself always returns all of them.
  fundingResumed?: number;
  stuckRefunds?: number;
  staleLocks?: number;
}

/**
 * Program-Fix 15 PR C: the ONE recovery re-instruction, serialized with a
 * sender cancel (sender-cancel.ts). A short transaction takes the transfer
 * `FOR UPDATE` (transfer → outbox, the lock order every writer uses) and
 * re-checks paid + refund none on the LOCKED row before enqueueing
 * `reinstruct:<id>`: findStuckPaid's read may predate a cancel or a refund
 * request that has since committed. True when a new row was created.
 */
export async function enqueueReinstructLocked(db: Db, transferId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const cur = await createTransferRepo(tx).getTransferForUpdate(transferId);
    if (!cur || cur.status !== 'paid' || (cur.refundStatus ?? 'none') !== 'none') return false;
    return createOutboxRepo(tx).enqueue('settlement.instruct', { transferId }, { dedupeKey: `reinstruct:${transferId}` });
  });
}

export async function reconcileSweep(db: Db, now: Date = new Date()): Promise<SweepResult> {
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  const integrationsRepo = createIntegrationsRepo(db);

  const stuck = await transfers.findStuckPaid(STUCK_PAID_MINUTES);
  let reinstructed = 0;
  // fix 8: a transfer whose rail reported `failed` / `returned` is NOT here —
  // handleRailFailure leaves `paid` (→ cancelled) and, when refundable, flips
  // refund_status to pending in the SAME transaction, and findStuckPaid is
  // `status = 'paid' AND refund_status = 'none'`. A `reinstruct:` row queued
  // BEFORE the failure landed is skipped by the instruct handler's own guard
  // (outbox-worker: cancelled / refund pending ⇒ done without a POST).
  for (const t of stuck) {
    // Best-rate routing: the rail that owes the callback is the SETTLEMENT
    // partner's when routed — classify (webhook-driven vs mock) by THEIR
    // config, or a routed stuck transfer reads the owner's (often mock)
    // config and is never re-instructed. The instruct handler re-resolves
    // the same routed id, so the re-instruction also goes to the right rail.
    const integrations = await integrationsRepo.getIntegrations(
      t.settlementPartnerId ?? t.partnerId,
    );
    const providerType = integrations.payment.providerType;
    // Program-Fix 44 P2: a sandbox transfer settles on the mock rail only, so
    // it is never re-instructed, whatever the rail config says.
    const webhookDriven = !isSandbox(t) && (providerType === 'http' || providerType === 'simulator');
    // fix 29 (money-09): the rail reported a DIFFERENT amount for this row — it
    // is held for staff (cancel/refund), never re-instructed. It keeps showing
    // here every sweep; the recon: alert below is still deduped (fires once).
    const held = await outbox.hasDedupeKey(`railamount:${t.id}`);
    let reinstructedNow = false;
    if (webhookDriven && !held) {
      // Exactly ONE recovery re-instruction per transfer (`reinstruct:` is a
      // different key from the original `instruct:` row, which is done/dead by
      // now). The instruct handler itself is idempotent on the partner side —
      // the reference is the transfer id, so their rail dedupes a replay.
      reinstructedNow = await enqueueReinstructLocked(db, t.id);
      if (reinstructedNow) reinstructed++;
    }
    // Mock-rail transfers land here too if their delayed settle died — the
    // dead-letter alert already fired for that row; this is the money-state view.
    // Routed transfers name the SETTLEMENT partner too — that's whose rail owes
    // the callback; pointing ops at only the owner would chase the wrong tenant.
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}` +
          (t.settlementPartnerId ? `, settles via ${t.settlementPartnerId}` : '') +
          `) has been ` +
          `'paid' for >${STUCK_PAID_MINUTES}min with no delivery confirmation.` +
          (held
            ? ' The rail reported a different amount — held, not re-instructed. Investigate with the rail, then cancel/refund it.'
            : webhookDriven
              ? reinstructedNow
                ? ' Re-instructed the partner rail once.'
                : ' Not re-instructed: on the locked re-check the transfer was no longer payable (cancelled, or a refund requested/in flight).'
              : ''),
      },
      { dedupeKey: `recon:${t.id}` },
    );
  }

  const stale = await transfers.findInReviewOlderThan(STALE_REVIEW_HOURS);
  for (const t of stale) {
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) has been ` +
          `in compliance review for >${STALE_REVIEW_HOURS}h — release or refund it.`,
      },
      { dedupeKey: `review:${t.id}` },
    );
  }

  // CRASH-RESUME: the customer was CHARGED (fundingRef is write-once, set
  // before settlement) but the process died before settlement/hold committed —
  // the one state the funds-capture seam can strand. Resume it through
  // settleOrHold, the same atomic claims the pay route uses, so the sweep
  // firing every minute moves each victim EXACTLY once and a victim racing its
  // own resurrected pay request is still a clean no-op. COMPLIANCE: a charged
  // FLAGGED victim is HELD (in_review + held stage-1 message, one transaction)
  // and never instructed; a charged BLOCKED victim (should not exist — blocked
  // rows are never charged) is left untouched with its own alert for ops to
  // refund. Both count as "resumed": the charged row reached its correct next
  // state. NEVER add a compliance predicate to listAwaitingWithFunding — that
  // would abandon charged flagged rows instead of holding them.
  const victims = await transfers.listAwaitingWithFunding(FUNDING_RESUME_MINUTES * 60_000);
  let fundingResumed = 0;
  for (const t of victims) {
    // Rail-side config is the SETTLEMENT partner's when routed (same rule as
    // the re-instruct above); the customer-facing stage-1 message rides the
    // OWNING partner's WhatsApp number — settleOrHold persists t.partnerId and
    // the worker resolves the brand creds at drain time (fix 11), never here.
    const railIntegrations = await integrationsRepo.getIntegrations(
      t.settlementPartnerId ?? t.partnerId,
    );
    const result = await settleOrHold(db, t, railIntegrations);
    const prefix = `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was charged (${t.fundingRef}) but never settled — `;
    switch (result.kind) {
      case 'started':
        fundingResumed++;
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'resumed settlement from the sweep.' },
          { dedupeKey: `fundresume:${t.id}` },
        );
        break;
      case 'held':
        // Correct ONLY because a staff release actually instructs the rail
        // (settlement.releaseHold, Step 2) — otherwise "held" would be a
        // charged row the rail is never told about.
        fundingResumed++;
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'flagged by compliance, so it was HELD for compliance review (in_review), not instructed. Release or reject it in the dashboard.' },
          { dedupeKey: `fundhold:${t.id}` },
        );
        break;
      case 'refused':
        // Charged AND blocked: nothing may move. Practically unreachable (a
        // sanctions hit lands as status 'blocked' at mint, before any charge,
        // and nothing re-screens a row after mint) — but the tests construct
        // it, so name the escalation honestly: there is NO in-app remedy for a
        // charged blocked row (fix 5's Cancel refuses a charged row, Refund
        // accepts only paid|delivered), so it is a change-ticket: refund at the
        // funding provider, then record the outcome with a direct ledger edit
        // (status 'cancelled', refund_status 'completed', refund_ref).
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'it is BLOCKED by compliance and was CHARGED. NOT settled. No dashboard action applies — refund at the funding provider and close it with a direct ledger edit under a change ticket.' },
          { dedupeKey: `fundblocked:${t.id}` },
        );
        break;
      case 'already':
        // Lost the race to a resurrected pay request / a concurrent sweep —
        // the row already moved; keep today's alert (deduped) for the record.
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'resumed settlement from the sweep.' },
          { dedupeKey: `fundresume:${t.id}` },
        );
        break;
    }
  }

  // CHARGED-BUT-CANCELLED (the capture↔cancel race): captureFunding is
  // provider.capture THEN setFundingRef, and the staff cancel guard (Task 5,
  // cancelIfCancellable) is `funding_ref IS NULL`, so a cancel landing between
  // those two calls leaves a cancelled row the customer paid for and nothing
  // refunds. No sweep watched that state. Alert once per row; ops refund it by
  // hand (issueRefund accepts paid|delivered only — by design, the remedy is a
  // human decision). Rows already refunding are Task 5's reject path at work.
  for (const t of await transfers.findCancelledCharged()) {
    await outbox.enqueue(
      'ops.alert',
      { message: `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) is CANCELLED but was CHARGED (${t.fundingRef}) and has no refund in flight — refund it by hand.` },
      { dedupeKey: `cancelcharged:${t.id}` },
    );
  }

  // STUCK REFUND: in flight (refundStatus 'pending') for over an hour. The
  // pending flip and the funding.refund effect commit together, so the OLDEST
  // funding.refund row's age IS the time the refund has been in flight (there
  // is no refund-pending timestamp on the ledger row). A pending refund with
  // NO effect row is a lost effect — equally stuck. Alert only, deduped: no
  // auto-retry, ops decides (the provider may be mid-incident).
  const pendingRefunds = await transfers.listByRefundStatus('pending', 50);
  let stuckRefunds = 0;
  for (const t of pendingRefunds) {
    const res = await db.execute(sql`
      SELECT count(*)::int AS recent FROM outbox
      WHERE kind = 'funding.refund'
        AND payload->>'transferId' = ${t.id}
        AND created_at > now() - make_interval(mins => ${STUCK_REFUND_MINUTES})
    `);
    const recent = Number((res as unknown as { rows: Array<{ recent: number }> }).rows[0]?.recent ?? 0);
    if (recent > 0) continue; // a fresh effect row exists — give it time
    stuckRefunds++;
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: refund for transfer ${t.id} (partner ${t.partnerId}) has been ` +
          `pending for >${STUCK_REFUND_MINUTES}min — check the funding provider and the outbox.`,
      },
      { dedupeKey: `refundstuck:${t.id}` },
    );
  }

  // STALE LOCKS (fix 7): leases the drain should have reclaimed but has not.
  // The alert is itself an outbox row — if the drain is dead it will not send,
  // which is why the ops page and scripts/outbox-status.ts read this out of
  // band. Ids/kinds only — never print a payload.
  const staleLocks = await outbox.listStaleProcessing(STALE_LOCK_MINUTES);
  for (const row of staleLocks) {
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) has sat in 'processing' for ` +
          `>${STALE_LOCK_MINUTES}m past its lease and was not reclaimed — the worker drain is not running; ` +
          `check the Vercel cron (Settings → Cron Jobs) and the GitHub heartbeat.`,
      },
      { dedupeKey: `stalelock:${row.id}` },
    );
  }

  // TICKET SLA DIGEST (Program-Fix 49C): staff-facing, never customer-facing.
  // Last, and isolated: a failed ticket read must never cost the money sweeps
  // above their result. SweepResult is deliberately unchanged.
  try {
    await sweepTicketSlaDigest(db, now);
  } catch (e) {
    logWarn('reconcile', 'ticket SLA digest skipped', { error: e instanceof Error ? e.message : String(e) });
  }

  return {
    stuckPaid: stuck.length,
    reinstructed,
    staleReviews: stale.length,
    fundingResumed,
    stuckRefunds,
    staleLocks: staleLocks.length,
  };
}

/** Oldest ticket ids named in the digest. */
const TICKET_SLA_DIGEST_IDS = 5;

/**
 * ONE ops.alert per UTC day (`ticketsla:<yyyy-mm-dd>`) when any customer ticket
 * is past its first-response target with no staff reply — never one alert per
 * ticket (an old backlog would otherwise fire N alerts at deploy). The day's
 * key is checked FIRST so the breach query runs at most until the digest is
 * queued. Ids, priorities and counts only: never a subject or a phone.
 * Returns whether a new digest row was queued.
 */
export async function sweepTicketSlaDigest(db: Db, now: Date): Promise<boolean> {
  const outbox = createOutboxRepo(db);
  const key = slaDigestKey(now);
  if (await outbox.hasDedupeKey(key)) return false;
  const breaches = await createTicketRepo(db).listSlaBreaches({ now, limit: TICKET_SLA_DIGEST_IDS });
  if (breaches.total === 0) return false;
  const h = FIRST_RESPONSE_DUE_HOURS;
  const b = breaches.byPriority;
  return outbox.enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: ${breaches.total} customer ticket(s) have no staff reply past the internal ` +
        `first-response target (urgent ${h.urgent}h / normal ${h.normal}h / low ${h.low}h): ` +
        `${b.urgent} urgent, ${b.normal} normal, ${b.low} low. ` +
        `Oldest: ${breaches.oldest.map((t) => `${t.id} (${t.priority}, partner ${t.partnerId})`).join(', ')}. ` +
        `Work them from Tickets.`,
    },
    { dedupeKey: key },
  );
}

// ── Ops data (consumed by the Stage-5 /admin-dashboard/ops page) ─────────────

export interface OpsSnapshot {
  pendingOutbox: number;
  deadLetters: OutboxRow[];
  /** 'processing' rows whose lease expired >STALE_LOCK_MINUTES ago and were not reclaimed. */
  staleLocks: OutboxRow[];
  stuckPaid: Transfer[];
  staleReviews: Transfer[];
  /** Refund queues (masked reads): customer-requested / in flight / failed. */
  refundsRequested: Transfer[];
  refundsPending: Transfer[];
  refundsFailed: Transfer[];
}

export async function getOpsSnapshot(db: Db): Promise<OpsSnapshot> {
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  return {
    pendingOutbox: await outbox.countPending(),
    deadLetters: await outbox.listDead(),
    staleLocks: await outbox.listStaleProcessing(STALE_LOCK_MINUTES),
    stuckPaid: await transfers.findStuckPaid(STUCK_PAID_MINUTES),
    staleReviews: await transfers.findInReviewOlderThan(STALE_REVIEW_HOURS),
    refundsRequested: await transfers.listByRefundStatus('requested'),
    refundsPending: await transfers.listByRefundStatus('pending'),
    refundsFailed: await transfers.listByRefundStatus('failed'),
  };
}
