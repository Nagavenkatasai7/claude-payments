import type { Db, DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { pokeWorker } from '@/lib/outbox';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { CANCEL_WINDOW_MS } from '@/lib/refund-policy';
import { buildSenderCancelMessage } from '@/lib/legal/cancel-drafts';
import { isSandbox } from '@/lib/settlement';
import type { PartnerId, Transfer } from '@/lib/types';

// sender-cancel — Program-Fix 15 PR C: the consumer sender's 30-minute
// cancellation (12 CFR 1005.34), RACE-FREE against the rail instruction.
//
// Owner decision (2026-09-23, C1): NO hold — settlement speed is unchanged, so
// a self-service cancel is honoured only while provably NO rail instruction
// has gone out. Everything else escalates to staff (C4: a transfer under
// compliance review always escalates, never auto-refunds).
//
// Why a status check is not enough: the worker reads the transfer, POSTs to
// the rail, and only THEN records the rail's ref. A `paid_out` callback on a
// row that is already `cancelled` is dropped (transfer-repo
// updateTransferFromWebhook), so cancelling after the rail was told could pay
// the recipient AND refund the sender. The proof is therefore the outbox
// itself, under locks, in ONE transaction:
//   1. `SELECT … FROM transfers … FOR UPDATE` (tenant-scoped): paid, consumer,
//      refund none|requested. (in_review is locked the same way and escalates
//      inside the window — its charge time falls back to paid_at for a legacy
//      held row with no stage1 row; none at all ⇒ window_passed.)
//   2. The charge time: the `stage1:<id>` row's age by the DATABASE clock.
//      Missing ⇒ fail closed (escalate). ≥ 30 min ⇒ window_passed.
//   3. `SELECT … FROM outbox WHERE dedupe_key IN (instruct:, reinstruct:,
//      mocksettle:<id>) FOR UPDATE` — BLOCKING, never SKIP LOCKED. claimBatch
//      flips a row to processing with attempts+1 and locked_at in ONE
//      autocommit UPDATE, so a claimed row is always seen as claimed.
//   4. Cancel only if ≥1 row exists and EVERY row is pending, attempts 0 and
//      locked_at NULL (never claimed — retryDead and releaseUnstarted reset
//      attempts but KEEP locked_at, so a row that ever ran never looks unrun),
//      and no rail ack ref is recorded. Those rows go `done` in this
//      transaction, then the transfer flips through failPaidFromRail's guarded
//      CASE (cancelled; refund → pending only when a charge was captured).
//   5. Otherwise: escalate — no flip; refund → requested (so a not-yet-POSTed
//      instruction holds and a later delivered callback is refused), one
//      deduped ops alert.
// Lock order is transfer → outbox everywhere (reconcile's re-instruction and
// the worker's payability read take the transfer lock too).

export type SenderCancelVia = 'receipt' | 'bot';

export type SenderCancelResult =
  | { kind: 'cancelled'; refundQueued: boolean }
  | { kind: 'escalated'; held?: true } // held: the transfer is under review (C4) — neutral customer copy
  | { kind: 'window_passed' }
  | { kind: 'ineligible' }
  | { kind: 'not_found' };

type EscalateReason = 'in_review' | 'no_charge_time' | 'no_rail_row' | 'rail_claimed' | 'rail_acked';

type LockedClaim =
  | { kind: 'not_found' }
  | { kind: 'ineligible' }
  | { kind: 'window_passed' }
  | { kind: 'escalate'; transfer: Transfer; reason: EscalateReason; msSinceCharge: number | null }
  | { kind: 'cancelled'; prior: Transfer; updated: Transfer; msSinceCharge: number };

const RAIL_ROW_DONE_NOTE = 'sender_cancel';

/**
 * Steps 1–4 above, on the caller's TRANSACTION handle. Pure decision + the
 * guarded writes; the effects (refund, confirmation, audit, alert) are the
 * caller's (cancelWithinWindow), in the same transaction.
 */
export async function cancelPaidBySenderLocked(tx: DbOrTx, partnerId: PartnerId, id: string): Promise<LockedClaim> {
  const repo = createTransferRepo(tx);
  const outbox = createOutboxRepo(tx);

  const t = await repo.getTransferForUpdate(id, { partnerId });
  if (!t) return { kind: 'not_found' };
  const refund = t.refundStatus ?? 'none';
  if (t.transferType === 'b2b') return { kind: 'ineligible' }; // not a consumer sender (1005.30)
  if (t.status !== 'paid' && t.status !== 'in_review') return { kind: 'ineligible' };
  if (refund !== 'none' && refund !== 'requested') return { kind: 'ineligible' };

  if (t.status === 'in_review') {
    // C4: a held transfer never auto-cancels; inside the window it escalates.
    // beginHold writes stage1:<id>; a legacy held row without one falls back to
    // paid_at (beginHold sets it; only a release resets it, and a released row
    // is `paid`). No charge time at all ⇒ window_passed: an old hold must never
    // raise a Reg E escalation at any age.
    const heldAge = (await outbox.chargeAgeMs(id)) ?? (await repo.paidAgeMs(id));
    if (heldAge === null || heldAge >= CANCEL_WINDOW_MS) return { kind: 'window_passed' };
    return { kind: 'escalate', transfer: t, reason: 'in_review', msSinceCharge: heldAge };
  }

  const age = await outbox.chargeAgeMs(id);
  // A paid row with no stage1:<id> (the rail `funded` callback path): the
  // charge time is unknown, so FAIL CLOSED — escalate, never auto-cancel.
  if (age === null) return { kind: 'escalate', transfer: t, reason: 'no_charge_time', msSinceCharge: null };
  if (age >= CANCEL_WINDOW_MS) return { kind: 'window_passed' };

  const rail = await outbox.lockRailRowsForTransfer(id);
  if (rail.length === 0) return { kind: 'escalate', transfer: t, reason: 'no_rail_row', msSinceCharge: age };
  const unrun = rail.every((r) => r.status === 'pending' && r.attempts === 0 && r.lockedAt === null);
  if (!unrun) return { kind: 'escalate', transfer: t, reason: 'rail_claimed', msSinceCharge: age };
  // Defence in depth: a recorded rail ack (anything but the mock rail's
  // pre-set deterministic ref) means the rail has the instruction.
  if (t.paymentProviderRef && t.paymentProviderRef !== `mock-${id}`) {
    return { kind: 'escalate', transfer: t, reason: 'rail_acked', msSinceCharge: age };
  }

  const ids = rail.map((r) => r.id);
  const moved = await outbox.markDoneLocked(ids, RAIL_ROW_DONE_NOTE);
  if (moved !== ids.length) {
    // Unreachable under the locks; never cancel what we could not stop.
    throw new Error('sender cancel: rail rows changed under the lock');
  }
  const { prior, updated } = await repo.failPaidFromRail(id, 'sender cancelled within 30 min of payment (Reg E)');
  if (!prior || !updated) throw new Error('sender cancel: the locked paid row did not flip');
  return { kind: 'cancelled', prior, updated, msSinceCharge: age };
}

function escalationAlert(t: Transfer, reason: EscalateReason): string {
  const who = `transfer ${t.id} (partner ${t.partnerId}${t.settlementPartnerId ? `, settles via ${t.settlementPartnerId}` : ''})`;
  if (reason === 'in_review') {
    return (
      `⚠️ SmartRemit ops: the sender of ${who} asked to cancel within 30 minutes of payment (Reg E) while it is held for review. ` +
      'Not auto-cancelled (C4). The refund is marked requested: decide it in the review (reject refunds; release keeps the request open until dismissed on Refunds).'
    );
  }
  return (
    `⚠️ SmartRemit ops: the sender of ${who} asked to cancel within 30 minutes of payment (Reg E), ` +
    `but the rail may already hold the instruction (${reason}). Not auto-cancelled. The refund is marked requested, so a not-yet-sent ` +
    'instruction is held. Recall it from the rail and approve the refund on Refunds, or dismiss the request so the instruction can go out.'
  );
}

/**
 * THE sender-cancel service. One transaction: the locked claim plus, on a
 * cancel, the refund effect (only when THIS flip moved refund none|requested →
 * pending), the WhatsApp confirmation and the audit row; on an escalation, the
 * guarded refund none → requested flag, one deduped ops alert and the audit
 * row. Idempotent: a repeat after a cancel is `ineligible`; a repeat after an
 * escalation re-escalates with no second alert.
 */
export async function cancelWithinWindow(
  db: Db,
  partnerId: PartnerId,
  transferId: string,
  opts: { via: SenderCancelVia },
): Promise<SenderCancelResult> {
  const res = await db.transaction(async (tx): Promise<SenderCancelResult> => {
    const claim = await cancelPaidBySenderLocked(tx, partnerId, transferId);
    const outbox = createOutboxRepo(tx);
    const audit = createAuditRepo(tx);
    switch (claim.kind) {
      case 'not_found':
      case 'ineligible':
      case 'window_passed':
        return { kind: claim.kind };
      case 'cancelled': {
        const { prior, updated } = claim;
        const priorRefund = prior.refundStatus ?? 'none';
        const refundQueued =
          (priorRefund === 'none' || priorRefund === 'requested') && updated.refundStatus === 'pending';
        if (refundQueued) {
          // The SAME dedupe key every refund path uses, so a later staff
          // approve can never queue a second refund.
          await outbox.enqueue('funding.refund', { transferId: updated.id }, { dedupeKey: `refund:${updated.id}` });
        }
        await outbox.enqueue(
          'whatsapp.text',
          {
            to: updated.phone,
            body: buildSenderCancelMessage(updated, refundQueued),
            partnerId: updated.partnerId,
            category: 'essential',
            // Program-Fix 44 parity: a sandbox transfer's message is completed
            // by the worker WITHOUT sending (never a real phone).
            ...(isSandbox(updated) ? { sandbox: true } : {}),
          },
          { dedupeKey: `sendercancel:${updated.id}` },
        );
        if (!refundQueued) {
          // Nothing was captured here (partner-funded) or a staff refund owns
          // it: the customer is told the team will contact them, and nothing
          // shows on Refunds — so ops are told, once (mirrors rail-failure).
          await outbox.enqueue(
            'ops.alert',
            {
              message:
                `⚠️ SmartRemit ops: the sender cancelled transfer ${updated.id} (partner ${updated.partnerId}) within 30 minutes of payment (Reg E). ` +
                'No refund was queued here (funds not captured by SmartRemit) — have the partner return the payment in full, including fees, within 3 business days, and contact the customer.',
            },
            { dedupeKey: `sendercancelfunds:${updated.id}` },
          );
        }
        await audit.record({
          partnerId: updated.partnerId,
          actor: 'system:customer-cancel',
          actorType: 'system',
          action: 'transfer.sender_cancel',
          subjectId: updated.id,
          meta: { via: opts.via, msSinceCharge: claim.msSinceCharge, refundQueued },
        });
        return { kind: 'cancelled', refundQueued };
      }
      case 'escalate': {
        const t = claim.transfer;
        await createTransferRepo(tx).updateRefund(t.id, { refundStatus: 'requested' }); // guarded none → requested; a repeat is a no-op
        await outbox.enqueue('ops.alert', { message: escalationAlert(t, claim.reason) }, { dedupeKey: `regecancel:${t.id}` });
        await audit.record({
          partnerId: t.partnerId,
          actor: 'system:customer-cancel',
          actorType: 'system',
          action: 'transfer.sender_cancel_escalated',
          subjectId: t.id,
          meta: { via: opts.via, reason: claim.reason, msSinceCharge: claim.msSinceCharge },
        });
        return claim.reason === 'in_review' ? { kind: 'escalated', held: true } : { kind: 'escalated' };
      }
    }
  });
  // partner-demo R4: committed rows (customer notice, refund, ops alert) —
  // poke so the gated cron never leaves them for the 30-min backstop.
  if (res.kind === 'cancelled' || res.kind === 'escalated') pokeWorker();
  return res;
}
