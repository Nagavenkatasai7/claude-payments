import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import type { Transfer } from '@/lib/types';

// reconcile — the safety-net sweep (Stage 2d). Runs in every /api/worker
// invocation (poke + 5-min heartbeat), AFTER the outbox drain. It catches the
// states the happy path can't lose silently anymore but an external party can
// still strand:
//   • a webhook-driven transfer stuck in 'paid' too long (the partner's rail
//     never called back, or the instruction died) → re-instruct ONCE + alert,
//   • a compliance hold ('in_review') nobody has touched in 24h → alert.
// Every enqueue is dedupe-keyed per transfer, so the sweep firing every minute
// can never spam: one re-instruction and one alert per stuck transfer, ever.

export const STUCK_PAID_MINUTES = 15;
export const STALE_REVIEW_HOURS = 24;

export interface SweepResult {
  stuckPaid: number;
  reinstructed: number;
  staleReviews: number;
}

export async function reconcileSweep(db: Db): Promise<SweepResult> {
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  const integrationsRepo = createIntegrationsRepo(db);

  const stuck = await transfers.findStuckPaid(STUCK_PAID_MINUTES);
  let reinstructed = 0;
  for (const t of stuck) {
    const integrations = await integrationsRepo.getIntegrations(t.partnerId);
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
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) has been ` +
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

  return { stuckPaid: stuck.length, reinstructed, staleReviews: stale.length };
}

// ── Ops data (consumed by the Stage-5 /admin-dashboard/ops page) ─────────────

export interface OpsSnapshot {
  pendingOutbox: number;
  deadLetters: OutboxRow[];
  stuckPaid: Transfer[];
  staleReviews: Transfer[];
}

export async function getOpsSnapshot(db: Db): Promise<OpsSnapshot> {
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  return {
    pendingOutbox: await outbox.countPending(),
    deadLetters: await outbox.listDead(),
    stuckPaid: await transfers.findStuckPaid(STUCK_PAID_MINUTES),
    staleReviews: await transfers.findInReviewOlderThan(STALE_REVIEW_HOURS),
  };
}
