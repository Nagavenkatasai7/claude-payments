import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { pokeWorker } from '@/lib/outbox';
import { scrub } from '@/lib/log';
import { isPartnerPulled } from '@/lib/funding-method';
import { buildRailFailureMessage, type RailFailureNoticeVariant } from '@/lib/payment';
import type { RailFailure } from '@/lib/providers/payment-provider';
import type { RefundStatus, Transfer } from '@/lib/types';

// rail-failure — THE transactional "the rail could not pay out" entry point
// (Program-Fix 8 / money-02, rail-02). A sibling of settlement.ts.
//
// A signed `failed` / `returned` callback for a PAID transfer commits, in ONE
// Postgres transaction under the row lock (transfer-repo.failPaidFromRail):
//   • status paid → cancelled (the EXISTING terminal state — no new status
//     value; rejectTransfer's shape: cancelled + refund_status + admin_note),
//     with the bounded, scrubbed rail reason on the admin note;
//   • refund_status none/requested → pending, but ONLY when there is money to
//     return here: SmartRemit captured funds (funding_ref) or the partner
//     pulled them (ach_pull / bank_pull → the worker's existing signed REVERSE);
//   • the durable funding.refund effect under `refund:<id>` — the SAME kind and
//     key as every staff refund path (ruling 21), so a staff refund and a rail
//     failure can never both refund (UNIQUE dedupe_key);
//   • the customer notice, chosen by the FINAL refund status (payload
//     { to, body, partnerId } — creds resolve at drain time, fix 18);
//   • one deduped ops alert.
// Other states are NEVER flipped: delivered (money is out — alert "after
// delivery"), awaiting_payment / in_review / blocked (never instructed — alert
// only). cancelled or missing is a no-op. Because the status leaves `paid` in
// the same transaction, findStuckPaid can never see the row again and a
// queued `reinstruct:` row is skipped by the instruct handler's own guard.
//
// The rail's `reason` is UNTRUSTED: bounded at the edge (parseRailFailure),
// scrub()-ed here (7+ digit runs and emails masked), and it reaches ops and
// the admin note only — never the customer, never the model.

export interface RailFailureOutcome {
  kind: 'failed' | 'alert_only' | 'noop';
  refundStarted: boolean;
}

function who(t: Transfer): string {
  return (
    `transfer ${t.id} (partner ${t.partnerId}` +
    (t.settlementPartnerId ? `, settles via ${t.settlementPartnerId}` : '') +
    ')'
  );
}

export async function handleRailFailure(
  db: Db,
  transferId: string,
  failure: RailFailure,
): Promise<RailFailureOutcome> {
  const reason = scrub(failure.reason);
  const note = `rail ${failure.code}: ${reason}`;
  const outcome = await db.transaction(async (tx): Promise<RailFailureOutcome> => {
    const repo = createTransferRepo(tx);
    const outbox = createOutboxRepo(tx);
    const { prior, updated } = await repo.failPaidFromRail(transferId, note);
    if (!prior || prior.status === 'cancelled') return { kind: 'noop', refundStarted: false };

    if (!updated) {
      // Not `paid`, by the LOCKED prior row: nothing moves, ops is told once.
      const detail =
        prior.status === 'delivered'
          ? `rail reported ${failure.code} AFTER delivery — the recipient was paid; investigate and claw back (Refund on the transfer's Details page) if the rail is right`
          : `rail reported ${failure.code} on a transfer that is ${prior.status} (never instructed) — nothing was changed; investigate`;
      // Keyed by the prior status so an early stray `failed` (e.g. while
      // awaiting_payment) can never spend the key the real cancel alert uses.
      await outbox.enqueue(
        'ops.alert',
        { message: `⚠️ SmartRemit ops: ${who(prior)}: ${detail}. Rail reason: ${reason}.` },
        { dedupeKey: `railfail:${transferId}:${prior.status}` },
      );
      return { kind: 'alert_only', refundStarted: false };
    }

    const priorRefund: RefundStatus = prior.refundStatus ?? 'none';
    const finalRefund: RefundStatus = updated.refundStatus ?? 'none';
    const pulled = isPartnerPulled(updated.fundingMethod);

    // 2. The refund effect — only when THIS claim flipped the refund to pending.
    let refundStarted = false;
    let path: string;
    if ((priorRefund === 'none' || priorRefund === 'requested') && finalRefund === 'pending') {
      refundStarted = await outbox.enqueue('funding.refund', { transferId }, { dedupeKey: `refund:${transferId}` });
      path = pulled
        ? 'the signed REVERSE of the partner-pulled debit is queued'
        : 'the refund of the captured charge is queued';
      // Unreachable by the invariants (refund:<id> exists only once the refund
      // left 'none'), but the failure itself must still commit: say so, don't roll back.
      if (!refundStarted) path += ' — a refund:<id> effect ALREADY existed; check the outbox';
    } else if (priorRefund === 'pending') {
      path = 'a staff refund is already in flight (no second refund queued)';
    } else if (priorRefund === 'completed') {
      path = 'the refund already completed (nothing more to return)';
    } else if (priorRefund === 'failed') {
      path = 'the prior refund FAILED — retry it from Refunds';
    } else {
      // none / requested and NOT refundable: no charge was captured here.
      path = 'funds were NOT captured by SmartRemit — partner-funded; the partner must return them to the sender';
    }

    // 3. The customer notice, by the FINAL refund status. completed / failed:
    //    no message (already refunded, or ops must act first) — alert only.
    let variant: RailFailureNoticeVariant | null = null;
    if (finalRefund === 'pending') variant = pulled ? 'reversal' : 'refund';
    else if (finalRefund === 'none' || finalRefund === 'requested') variant = 'contact';
    if (variant) {
      await outbox.enqueue(
        'whatsapp.text',
        { to: updated.phone, body: buildRailFailureMessage(updated, variant), partnerId: updated.partnerId },
        { dedupeKey: `railfailmsg:${transferId}` },
      );
    }

    // 4. Ops, once.
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: rail reported ${failure.code} for ${who(updated)} — CANCELLED. ` +
          `Refund ${priorRefund} → ${finalRefund}: ${path}. Rail reason: ${reason}.`,
      },
      { dedupeKey: `railfail:${transferId}` },
    );
    return { kind: 'failed', refundStarted };
  });
  pokeWorker(); // fast path — the per-minute cron drains it regardless
  return outcome;
}

/**
 * fix 8: a signed `paid_out` that updateTransferFromWebhook REFUSED is never
 * silent when money may have moved twice. Re-reads the row: cancelled (a rail
 * failure or a reject already returned the money), or paid with a refund in
 * any state but 'none' (a staff refund racing the delivery) ⇒ ONE deduped
 * `railconflict:<id>` alert; the row is not changed. Anything else stays
 * silent as before: a duplicate paid_out on a delivered row (refunding or
 * not), blocked, in_review, or a missing row. Returns true when the alert was
 * enqueued (false on dedupe or no conflict).
 */
export async function alertRefusedDelivery(db: Db, transferId: string): Promise<boolean> {
  const t = await createTransferRepo(db).getTransfer(transferId);
  if (!t) return false;
  const refund: RefundStatus = t.refundStatus ?? 'none';
  const conflict = t.status === 'cancelled' || (t.status === 'paid' && refund !== 'none');
  if (!conflict) return false;
  return createOutboxRepo(db).enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: rail reported paid_out for ${who(t)} AFTER a cancel/refund ` +
        `(status ${t.status}, refund ${refund}) — the delivery was REFUSED here, but the recipient may have been paid ` +
        `AND the sender refunded (money may have moved twice). Reconcile with the rail.`,
    },
    { dedupeKey: `railconflict:${transferId}` },
  );
}
