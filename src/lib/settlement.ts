import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { DELIVERY_DELAY_MS } from '@/lib/providers/payment-provider';
import { buildStage1Message } from '@/lib/payment';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Transfer } from '@/lib/types';

// settlement — THE transactional "money was paid" entry point (Stage 2c).
//
// One Postgres transaction commits, together:
//   • the awaiting_payment → paid status flip (atomic claim — a double submit
//     or crash-replay flips nothing and is a clean no-op),
//   • the customer's stage-1 "payment received" message (outbox, deduped;
//     the payload names the OWNING partnerId only — the worker resolves that
//     partner's WhatsApp creds at drain time, so no token is ever at rest here),
//   • the settlement effect for the partner's rail:
//       http/simulator → a SIGNED settlement.instruct row (the worker POSTs it
//                        with retries; delivery arrives via the partner's
//                        signed callback — fully webhook-driven),
//       mock          → a DELAYED mock.settle row (the sandbox 2-min lag).
//
// This closes the worst crash window the audit found: previously the customer
// could be told "payment received" while the rail was never instructed (or
// vice-versa). Now the state flip and every effect are one atomic unit, and
// each effect is dedupe-keyed so retries can never double-send.
// COMPLIANCE: only 'cleared' money reaches a rail — see beginSettlement / beginHold / settleOrHold below — and a staff RELEASE (releaseHold) is the one other path to the rail, audited, never a bare status flip.
//
// NON-CUSTODIAL: SmartRemit never holds funds — `paid` mirrors the charge the
// PARTNER captured on their rail; the instruction tells their rail to pay out.

export type SettlementResult =
  | { kind: 'started'; webhookDriven: boolean }
  | { kind: 'already' } // not awaiting_payment anymore — idempotent no-op
  | { kind: 'refused'; complianceStatus: 'flagged' | 'blocked' }; // NOT cleared — never instructed

export type HoldResult =
  | { kind: 'held' } // awaiting_payment → in_review committed (+ held stage-1 row)
  | { kind: 'already' }; // not awaiting_payment anymore — idempotent no-op

/**
 * The union every settlement CALLER must handle exhaustively (switch on
 * `kind` — TypeScript refuses a missing arm). There is deliberately no arm a
 * caller can mistake for success: 'held' is a compliance hold (in_review,
 * staff release is the only way forward), 'refused' is a blocked transfer that
 * moved nothing. A caller that reaches 'refused' after charging must surface
 * it (ops alert / 4xx) — never swallow it.
 */
export type SettleOrHoldResult =
  | { kind: 'started'; webhookDriven: boolean }
  | { kind: 'held' }
  | { kind: 'already' }
  | { kind: 'refused'; complianceStatus: 'blocked' };

export type ReleaseResult =
  | { kind: 'released'; webhookDriven: boolean } // in_review → paid committed + the rail effect enqueued
  | { kind: 'already' }; // not in_review anymore — idempotent no-op, never resurrects

/**
 * The ONE rail-effect enqueue, shared by beginSettlement (cleared money) and
 * releaseHold (staff-released money) so the two can never drift: a webhook-
 * driven rail gets the signed instruction (`instruct:<id>`), the mock rail gets
 * the delayed simulated settlement (`mocksettle:<id>`) plus the deterministic
 * write-once providerRef. Both keys are forever; a replay enqueues nothing.
 */
async function enqueueRailEffect(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  paid: Transfer,
  integrations: PartnerIntegrations,
): Promise<{ webhookDriven: boolean }> {
  const providerType = integrations.payment.providerType;
  const webhookDriven = providerType === 'http' || providerType === 'simulator';
  const outbox = createOutboxRepo(tx);
  if (webhookDriven) {
    await outbox.enqueue('settlement.instruct', { transferId: paid.id }, { dedupeKey: `instruct:${paid.id}` });
  } else {
    await outbox.enqueue(
      'mock.settle',
      { transferId: paid.id, partnerId: paid.partnerId },
      { delayMs: DELIVERY_DELAY_MS, dedupeKey: `mocksettle:${paid.id}` },
    );
    // Parity with the old mock provider's deterministic ref (write-once).
    await createTransferRepo(tx).setProviderRef(paid.id, `mock-${paid.id}`);
  }
  return { webhookDriven };
}

/**
 * COMPLIANCE GATE: only 'cleared' money reaches a rail. The gate is the
 * ledger claim itself (markPaidIfAwaiting requires compliance_status =
 * 'cleared' in its WHERE), so a caller holding a stale Transfer object cannot
 * bypass it; when the claim returns null we re-read INSIDE the same
 * transaction to distinguish "already past awaiting_payment" (replay, no-op)
 * from "not cleared" (refused). Callers should normally go through
 * settleOrHold(); this stays exported for the reconcile sweep's cleared path
 * and for tests.
 */
export async function beginSettlement(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<SettlementResult> {
  return db.transaction(async (tx): Promise<SettlementResult> => {
    const repo = createTransferRepo(tx);
    const paid = await repo.markPaidIfAwaiting(transfer.id);
    if (!paid) {
      // Classify from the LEDGER, inside the same transaction. A cleared +
      // awaiting row here is unreachable (the UPDATE would have matched), so
      // it maps to the harmless no-op rather than a spurious refusal.
      const row = await repo.getTransfer(transfer.id);
      if (!row || row.status !== 'awaiting_payment' || row.complianceStatus === 'cleared') {
        return { kind: 'already' };
      }
      return { kind: 'refused', complianceStatus: row.complianceStatus };
    }

    // Brand vs rail: the customer-facing message rides the OWNING partner's
    // WhatsApp number (paid.partnerId, already in hand — no read added to this
    // transaction); the rail is decided from `integrations` below. Only the id
    // is persisted (fix 11 / F49): the worker resolves the creds at DRAIN time.
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      { to: paid.phone, body: buildStage1Message(paid), partnerId: paid.partnerId },
      { dedupeKey: `stage1:${paid.id}` },
    );
    const { webhookDriven } = await enqueueRailEffect(tx, paid, integrations);
    return { kind: 'started', webhookDriven };
  });
}

/**
 * THE transactional compliance HOLD (Phase 1 Task 3). One Postgres
 * transaction commits, together:
 *   • the awaiting_payment → in_review status flip (atomic claim —
 *     markInReviewIfAwaiting; a replay / crash-retry flips nothing),
 *   • paid_at (the customer WAS charged; the >24h stale-review sweep keys on it),
 *   • the customer's held "payment received — under review" message as a
 *     durable outbox row (dedupe stage1:<id> — the SAME key the paid path
 *     uses, so a transfer gets exactly one stage-1 message however it got here).
 * NO rail effect is enqueued HERE: the rail is told only when staff RELEASE
 * the transfer — releaseHold below — which is itself a settlement (in_review →
 * paid + the same rail effect). A released transfer keeps complianceStatus
 * 'flagged' forever: the release is the audited compliance decision, the
 * ledger evidence is never rewritten, and NO compliance predicate may ever be
 * added to markPaidIfInReview / releaseHold.
 *
 * Replaces the pay route's old completePaymentStage1 + re-read + saveTransfer
 * + direct sendText sequence, which had an observable intermediate 'paid'
 * state and a non-durable message.
 */
export async function beginHold(db: Db, transfer: Transfer): Promise<HoldResult> {
  return db.transaction(async (tx): Promise<HoldResult> => {
    const held = await createTransferRepo(tx).markInReviewIfAwaiting(transfer.id);
    if (!held) return { kind: 'already' };
    // `held` is the masked RETURNING row; buildStage1Message never names the
    // destination, so no payout field can reach the outbox payload. Same shape
    // as the paid stage-1: the OWNING partnerId, never creds (fix 11 / F49).
    await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      { to: held.phone, body: buildStage1Message(held, { held: true }), partnerId: held.partnerId },
      { dedupeKey: `stage1:${held.id}` },
    );
    return { kind: 'held' };
  });
}

/**
 * The ONE decision function for "money was captured (or the partner pulls
 * it) — what happens now?". Every settlement call site (pay route, B2B pay
 * route, partner-API confirm, reconcile funding-resume sweep) goes through
 * here so the compliance branching exists in exactly one place:
 *   blocked → refused (nothing moves; callers already 4xx/422 before charging)
 *   cleared → beginSettlement (and if the LEDGER disagrees — re-screened to
 *             flagged since the caller's read — fall through to the hold)
 *   flagged → beginHold
 */
export async function settleOrHold(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<SettleOrHoldResult> {
  if (transfer.complianceStatus === 'blocked') {
    return { kind: 'refused', complianceStatus: 'blocked' };
  }
  if (transfer.complianceStatus === 'cleared') {
    const settled = await beginSettlement(db, transfer, integrations);
    if (settled.kind !== 'refused') return settled;
    if (settled.complianceStatus === 'blocked') return { kind: 'refused', complianceStatus: 'blocked' };
    // Ledger says flagged: hold it.
  }
  return beginHold(db, transfer);
}

/**
 * THE staff RELEASE of a held transfer (Phase 1 Task 3). A release is a
 * SETTLEMENT, not a status flip: one Postgres transaction commits, together,
 *   • the in_review → paid claim (markPaidIfInReview — NO compliance predicate:
 *     the admin-gated, audited release action IS the compliance decision, and
 *     complianceStatus stays 'flagged' as evidence),
 *   • the SAME rail effect beginSettlement enqueues (instruct:<id> for a
 *     webhook-driven rail; the delayed mocksettle:<id> + mock providerRef for
 *     the mock rail) — so the partner rail is actually told to pay out (and to
 *     debit a B2B ach_pull/bank_pull buyer), exactly as for cleared money.
 * No stage-1 message here (stage1:<id> was sent by the hold). The delivered
 * message then arrives through the ordinary paid → delivered path (rail
 * callback / mock.settle handler). Null claim ⇒ 'already': never held, already
 * released, or rejected — nothing moves, nothing is enqueued.
 * Callers hand this the RAIL partner's integrations (settlementPartnerId ??
 * partnerId), the same rule as every other settlement caller.
 */
export async function releaseHold(
  db: Db,
  transfer: Transfer,
  integrations: PartnerIntegrations,
): Promise<ReleaseResult> {
  return db.transaction(async (tx): Promise<ReleaseResult> => {
    const paid = await createTransferRepo(tx).markPaidIfInReview(transfer.id);
    if (!paid) return { kind: 'already' };
    const { webhookDriven } = await enqueueRailEffect(tx, paid, integrations);
    return { kind: 'released', webhookDriven };
  });
}
