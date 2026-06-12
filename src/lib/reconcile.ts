import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { beginSettlement } from '@/lib/settlement';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import type { Transfer } from '@/lib/types';

// reconcile — the safety-net sweep (Stage 2d). Runs in every /api/worker
// invocation (poke + 5-min heartbeat), AFTER the outbox drain. It catches the
// states the happy path can't lose silently anymore but an external party can
// still strand:
//   • a webhook-driven transfer stuck in 'paid' too long (the partner's rail
//     never called back, or the instruction died) → re-instruct ONCE + alert,
//   • a compliance hold ('in_review') nobody has touched in 24h → alert,
//   • a CHARGED transfer still awaiting_payment (fundingRef set; the process
//     died between capture and beginSettlement) → resume settlement + alert,
//   • a refund in flight for over an hour → alert (ops decides; no auto-retry).
// Every enqueue is dedupe-keyed per transfer, so the sweep firing every minute
// can never spam: one re-instruction and one alert per stuck transfer, ever.

export const STUCK_PAID_MINUTES = 15;
export const STALE_REVIEW_HOURS = 24;
export const FUNDING_RESUME_MINUTES = 10;
export const STUCK_REFUND_MINUTES = 60;

export interface SweepResult {
  stuckPaid: number;
  reinstructed: number;
  staleReviews: number;
  // Optional ONLY so pre-existing zero-literals (the worker route's fallback)
  // stay assignable; reconcileSweep itself always returns both.
  fundingResumed?: number;
  stuckRefunds?: number;
}

export async function reconcileSweep(db: Db): Promise<SweepResult> {
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  const integrationsRepo = createIntegrationsRepo(db);

  const stuck = await transfers.findStuckPaid(STUCK_PAID_MINUTES);
  let reinstructed = 0;
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
    const webhookDriven = providerType === 'http' || providerType === 'simulator';
    if (webhookDriven) {
      // Exactly ONE recovery re-instruction per transfer (`reinstruct:` is a
      // different key from the original `instruct:` row, which is done/dead by
      // now). The instruct handler itself is idempotent on the partner side —
      // the reference is the transfer id, so their rail dedupes a replay.
      const fresh = await outbox.enqueue(
        'settlement.instruct',
        { transferId: t.id },
        { dedupeKey: `reinstruct:${t.id}` },
      );
      if (fresh) reinstructed++;
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
          (webhookDriven ? ' Re-instructed the partner rail once.' : ''),
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
  // before beginSettlement) but the process died before settlement started —
  // the one state the funds-capture seam can strand. Resume it: beginSettlement
  // is the same atomic claim the pay route uses (markPaidIfAwaiting), so the
  // sweep firing every minute settles each victim EXACTLY once, and a victim
  // racing its own resurrected pay request is still a clean no-op.
  const victims = await transfers.listAwaitingWithFunding(FUNDING_RESUME_MINUTES * 60_000);
  let fundingResumed = 0;
  for (const t of victims) {
    // Rail-side config is the SETTLEMENT partner's when routed (same rule as
    // the re-instruct above); the customer-facing stage-1 message rides the
    // OWNING partner's WhatsApp number (brand-side).
    const railIntegrations = await integrationsRepo.getIntegrations(
      t.settlementPartnerId ?? t.partnerId,
    );
    const brandIntegrations = t.settlementPartnerId
      ? await integrationsRepo.getIntegrations(t.partnerId)
      : railIntegrations;
    const result = await beginSettlement(db, t, railIntegrations, waCredsFrom(brandIntegrations));
    if (result.kind === 'started') fundingResumed++;
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was charged ` +
          `(${t.fundingRef}) but never settled — resumed settlement from the sweep.`,
      },
      { dedupeKey: `fundresume:${t.id}` },
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

  return {
    stuckPaid: stuck.length,
    reinstructed,
    staleReviews: stale.length,
    fundingResumed,
    stuckRefunds,
  };
}

// ── Ops data (consumed by the Stage-5 /admin-dashboard/ops page) ─────────────

export interface OpsSnapshot {
  pendingOutbox: number;
  deadLetters: OutboxRow[];
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
    stuckPaid: await transfers.findStuckPaid(STUCK_PAID_MINUTES),
    staleReviews: await transfers.findInReviewOlderThan(STALE_REVIEW_HOURS),
    refundsRequested: await transfers.listByRefundStatus('requested'),
    refundsPending: await transfers.listByRefundStatus('pending'),
    refundsFailed: await transfers.listByRefundStatus('failed'),
  };
}
