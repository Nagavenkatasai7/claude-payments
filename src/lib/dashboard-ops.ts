import { suppressForOptOut, type OptOutLookup } from './consent-gate';
import { env } from './env';
import { isPartnerPulled } from './funding-method';
import { CANCEL_REFUSAL, decideStaffCancel } from './dashboard-cancel-policy';
import { pokeWorker } from './outbox';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { releaseHold, recordStaffTransferAudit, type StaffAuditCtx } from './settlement';
export type { StaffAuditCtx } from './settlement';
import type { Db } from '@/db/client';
import type { Store } from './store';
import type { Scope } from './staff-scope';
import type { Partner, Transfer } from './types';
import { isScreeningHold } from './compliance-config';

/**
 * Staff "Cancel" = VOID an UNFUNDED draft, and nothing else (Phase 1 Task 5 /
 * Program-Fix 9 / money-05). NON-CUSTODIAL: this function commits NO effect
 * (no refund, no reversal, no rail message), so it may only flip a row with no
 * money behind it. The rule is the pure decideStaffCancel
 * (dashboard-cancel-policy), shared with the transactions list and the B2B page:
 *   • delivered / cancelled → silent no-op (a second click is never an error),
 *   • paid → refused: custodial → Refund (issueRefund), partner-pulled → Reverse,
 *   • ANY in_review hold, charged or not → refused: a hold is a compliance
 *     decision, so Reject (admin; cancel-only when uncharged, cancel +
 *     auto-refund when charged, one txn) or Release (admin),
 *   • charged awaiting_payment → refused: the funding-resume sweep settles or holds it,
 *   • blocked → refused (terminal compliance state),
 *   • otherwise (an unfunded awaiting_payment draft) → ONE guarded UPDATE
 *     (store.cancelTransferIfUnfunded → transfer-repo.cancelIfCancellable).
 *     The read above is advisory; the UPDATE is the claim. A miss means the
 *     row moved (paid flip, hold, capture, or a concurrent click): refuse
 *     from the FRESH row, and never fall back to a write.
 * Why refuse instead of flipping: a cancelled row is invisible to every safety
 * net. updateTransferFromWebhook refuses it, findStuckPaid skips it, and
 * issueRefund rejects it. A charged transfer cancelled here used to strand the
 * sender's money, with reconcile's cancelcharged:<id> alert as the only trace.
 */
export async function cancelTransfer(store: Store, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  const decision = decideStaffCancel(transfer);
  if (decision.kind === 'noop') return;
  if (decision.kind === 'refuse') throw new Error(decision.reason);
  // Tenant-scoped claim: the row's own partner (the action already enforced the
  // caller's scope via getScopedTransfer / platform scope before calling here).
  if (await store.cancelTransferIfUnfunded(id, transfer.partnerId)) return;
  const fresh = await store.getTransfer(id);
  const again = fresh ? decideStaffCancel(fresh) : null;
  throw new Error(again?.kind === 'refuse' ? again.reason : CANCEL_REFUSAL.changed);
}

/**
 * Reverse a PAID/DELIVERED B2B ach_pull transfer (staff-approved). NON-CUSTODIAL:
 * SmartRemit captured nothing — so unlike issueRefund this does NOT require a
 * fundingRef. It flips refundStatus none → pending and enqueues the durable
 * funding.refund effect IN ONE TRANSACTION; the worker's ach_pull branch turns
 * that into a SIGNED partner REVERSE instruction (not a PSP refund). Eligibility
 * is re-checked inside the txn so a double-click / wrong state throws and
 * enqueues nothing, and the fresh-row assert prevents a flip with no effect to
 * drain. The staff click IS the approval (the buyer's request_refund only flips
 * none → requested; a human runs this).
 */
export async function reverseB2bSettlement(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await repo.getTransfer(id);
    if (!transfer) {
      throw new Error('Cannot reverse: transfer not found.');
    }
    if (!isPartnerPulled(transfer.fundingMethod)) {
      throw new Error('Cannot reverse: only partner-pulled (ACH/bank) transfers are reversed — use Refund.');
    }
    if (transfer.status !== 'paid' && transfer.status !== 'delivered') {
      throw new Error(
        `Cannot reverse: transfer is ${transfer.status} — only paid or delivered partner-pulled transfers can be reversed.`,
      );
    }
    if ((transfer.refundStatus ?? 'none') !== 'none') {
      throw new Error('Cannot reverse: a reversal is already in progress or complete for this transfer.');
    }
    await repo.updateRefund(id, { refundStatus: 'pending' });
    const fresh = await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}` },
    );
    if (!fresh) {
      throw new Error('Cannot reverse: a reversal effect already exists for this transfer.');
    }
  });
  pokeWorker();
}

export async function assignTransfer(
  store: Store,
  id: string,
  assignee: string,
  note: string,
): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  // Status-guarded + column-targeted: never a stale full-row upsert.
  const assigned = await store.updateTransferIfStatus(id, transfer.status, { assignedTo: assignee, adminNote: note });
  if (!assigned) {
    throw new Error('Cannot assign: the transfer changed concurrently — reload and try again.');
  }
}

/**
 * Program-Fix 49A: a pay-link resend is NONESSENTIAL — refused, with a
 * staff-readable reason, when the customer opted out (STOP) under the
 * transfer's own tenant. `consent` is injected (the action passes the
 * customer store) so the check runs on the caller's database.
 */
export async function resendPaymentLink(
  store: Store,
  sendText: (to: string, text: string) => Promise<void>,
  id: string,
  consent?: OptOutLookup,
): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (consent && (await suppressForOptOut(consent, transfer.partnerId, transfer.phone, 'nonessential'))) {
    throw new Error('Cannot resend: this customer has opted out of WhatsApp messages (replied STOP).');
  }
  const url = `${env.appBaseUrl}/pay/${id}`;
  await sendText(transfer.phone, `Here is your secure payment link again: ${url}`);
}

/**
 * WHO may release a compliance hold. OWNER DECISION (2026-09-16): releasing a
 * transfer that SmartRemit's OWN screening flagged — owning partner kycMode
 * 'ours', which is also the default when kycMode is unset — requires PLATFORM
 * staff. A partner-scoped admin may release only a 'delegated'-mode partner's
 * hold. A missing partner row fails CLOSED for partner-scoped staff.
 * Program-Fix 43 follow-up: even under 'delegated', a hold whose reasons came
 * from sanctions / name screening (isScreeningHold — KYC may be delegated,
 * sanctions may not) stays PLATFORM-only; a hold with no reasons fails closed.
 * Sanctions-blocked rows stay unreleasable for everyone regardless of this
 * (markPaidIfInReview carries compliance_status <> 'blocked').
 * Pure: the server action (authoritative gate) and the compliance page (which
 * hides the Release button) both call it, so the UI can never drift from it.
 */
export function canReleaseHeld(
  scope: Scope,
  owner: Pick<Partner, 'kycMode'> | null | undefined,
  transfer: Pick<Transfer, 'complianceReasons'>,
): boolean {
  if (scope.kind === 'platform') return true;
  if (owner?.kycMode !== 'delegated') return false;
  return !isScreeningHold(transfer);
}

/**
 * Release a held (in_review) transfer — a SETTLEMENT, not a status flip:
 * settlement.releaseHold commits in_review → paid AND the rail effect (signed
 * instruct / delayed mock settle) in ONE transaction, so the partner rail is
 * actually told to pay out (and to debit a B2B buyer). Rail config follows
 * the same rule as every settlement caller: the SETTLEMENT partner's when
 * routed, else the owner's. Throws if the transfer is not exactly in_review
 * (guards double-release / wrong status) — the status check is re-done by the
 * guarded claim inside releaseHold, so a race can never release twice.
 * Called by the compliance dashboard "Release" action (admin-gated, audited).
 */
export async function releaseTransfer(store: Store, db: Db, id: string, audit: StaffAuditCtx): Promise<void> {
  // Program-Fix 43 follow-up (defence in depth behind releaseTransferAction):
  // every release records WHO and WHY, so no audit context or a blank reason
  // is refused before any read or write.
  if (!audit || typeof audit.reason !== 'string' || audit.reason.trim() === '') {
    throw new Error('A release reason is required.');
  }
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot release: transfer is not in_review (current status: ${transfer.status})`);
  }
  const railIntegrations = await createIntegrationsRepo(db).getIntegrations(transfer.settlementPartnerId ?? transfer.partnerId);
  // Program-Fix 28: the audit row is written INSIDE releaseHold's transaction.
  const r = await releaseHold(db, transfer, railIntegrations, audit);
  if (r.kind === 'already') {
    throw new Error('Cannot release: transfer is not in_review (it moved concurrently)');
  }
  pokeWorker(); // fast path for the rail effect — the per-minute cron drains it regardless
}

/**
 * Reject a held (in_review) transfer: cancel it with an admin note, and — when
 * the sender was actually CHARGED (fundingRef set by the funds-capture seam) —
 * AUTO-refund: refundStatus → pending plus a durable funding.refund effect,
 * committed together so a crash can never strand a charged-but-unrefunded
 * reject. Uncharged legacy rows keep the old cancel-only behavior.
 * Called by the compliance dashboard "Reject" action.
 * Throws if the transfer is not exactly in_review.
 */
export async function rejectTransfer(store: Store, db: Db, id: string, audit?: StaffAuditCtx): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot reject: transfer is not in_review (current status: ${transfer.status})`);
  }
  // The in_review check above is advisory; the GUARDED UPDATE below is the
  // claim. A concurrent release (in_review → paid + rail instructed) between
  // the read and here makes it match nothing ⇒ throw, enqueue nothing — never
  // pay out AND refund. CHARGED: the cancel claim, the refund-pending flip and
  // the durable funding.refund effect commit in ONE transaction, so a crash
  // can never leave a cancelled, charged, UNREFUNDED transfer.
  const refunding = await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const cancelled = await repo.updateIfStatus(id, 'in_review', { status: 'cancelled', adminNote: 'rejected in review' });
    if (!cancelled) {
      throw new Error('Cannot reject: transfer is not in_review (it moved concurrently)');
    }
    // Program-Fix 28: the audit row BEFORE the uncharged early return, so both
    // branches record the decision in this transaction.
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'transfer.reject', cancelled, {
        previousStatus: 'in_review',
        newStatus: 'cancelled',
        refundStatus: cancelled.fundingRef ? 'pending' : 'none',
      });
    }
    if (!cancelled.fundingRef) return false; // uncharged legacy row: cancel-only
    await repo.updateRefund(id, { refundStatus: 'pending' });
    await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}` },
    );
    return true;
  });
  if (!refunding) return;
  pokeWorker(); // fast path — the per-minute cron drains it regardless
}

/**
 * PROACTIVELY issue a refund on a PAID or DELIVERED transfer that was actually
 * charged (fundingRef set) — admin-initiated, no prior customer request needed.
 * none → pending + the durable funding.refund effect, one transaction, with the
 * eligibility re-checked INSIDE it so a double-click or an ineligible transfer
 * throws and enqueues nothing. Refunding a DELIVERED transfer is a clawback the
 * operator settles out-of-band; the seam just returns the original charge.
 *
 * Defensive beyond its siblings: it asserts the funding.refund row is FRESH
 * (enqueue returns false on dedupe-key conflict) and throws to roll back the
 * pending flip if not — so a stale `refund:<id>` row can never leave a transfer
 * flipped-to-pending with no effect to drain (a state no sweep would heal).
 */
export async function issueRefund(db: Db, id: string, audit?: StaffAuditCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await repo.getTransfer(id);
    if (!transfer) {
      throw new Error('Cannot refund: transfer not found.');
    }
    if (transfer.status !== 'paid' && transfer.status !== 'delivered') {
      throw new Error(
        `Cannot refund: transfer is ${transfer.status} — only paid or delivered transfers can be refunded.`,
      );
    }
    if (!transfer.fundingRef) {
      throw new Error('Cannot refund: transfer was never charged (no funding reference).');
    }
    if ((transfer.refundStatus ?? 'none') !== 'none') {
      throw new Error('Cannot refund: a refund is already in progress or complete for this transfer.');
    }
    await repo.updateRefund(id, { refundStatus: 'pending' });
    const fresh = await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}` },
    );
    if (!fresh) {
      throw new Error('Cannot refund: a refund effect already exists for this transfer.');
    }
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.issue', transfer, {
        previousStatus: transfer.status,
        newStatus: transfer.status,
        previousRefundStatus: 'none',
        refundStatus: 'pending',
      });
    }
  });
  pokeWorker();
}

/**
 * Approve a CUSTOMER-REQUESTED refund: requested → pending + the durable
 * funding.refund effect, one transaction. The state is re-checked inside the
 * transaction, so a double-click (or a refund never requested) throws and
 * enqueues nothing — refunds are never minted from thin air.
 */
export async function approveRefund(db: Db, id: string, audit?: StaffAuditCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await repo.getTransfer(id);
    if (!transfer || (transfer.refundStatus ?? 'none') !== 'requested') {
      throw new Error('Cannot approve: refund is not awaiting approval.');
    }
    await repo.updateRefund(id, { refundStatus: 'pending' });
    await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}` },
    );
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.approve', transfer, {
        previousStatus: transfer.status,
        newStatus: transfer.status,
        previousRefundStatus: 'requested',
        refundStatus: 'pending',
      });
    }
  });
  pokeWorker();
}

/**
 * Dismiss a CUSTOMER-REQUESTED refund: requested → none + an adminNote trail.
 * The guarded updateRefund (legal only from 'requested') is the gate — an
 * in-flight or completed refund can never be "dismissed" away.
 */
export async function dismissRefund(db: Db, id: string, audit?: StaffAuditCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const updated = await repo.updateRefund(id, { refundStatus: 'none' });
    if (!updated) {
      throw new Error('Cannot dismiss: refund is not awaiting approval.');
    }
    // APPENDED after any existing note (a rail-failure note, a staff note) —
    // the same rule as transfer-repo.failPaidFromRail; never clobbered.
    const prior = (updated.adminNote ?? '').trim();
    await repo.saveTransfer({
      ...updated,
      adminNote: prior === '' ? 'refund request dismissed' : `${prior} | refund request dismissed`,
    });
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.dismiss', updated, {
        previousStatus: updated.status,
        newStatus: updated.status,
        previousRefundStatus: 'requested',
        refundStatus: 'none',
      });
    }
  });
}

/**
 * Retry a FAILED refund: failed → pending + a fresh funding.refund effect.
 * The original `refund:<id>` dedupe key is spent (that row ran and the
 * provider reported failure), so each retry mints a unique key — while the
 * failed-state check inside the transaction keeps double-clicks to one.
 */
export async function retryRefund(db: Db, id: string, audit?: StaffAuditCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await repo.getTransfer(id);
    if (!transfer || (transfer.refundStatus ?? 'none') !== 'failed') {
      throw new Error('Cannot retry: refund is not in a failed state.');
    }
    await repo.updateRefund(id, { refundStatus: 'pending' });
    await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}:retry:${Date.now()}` },
    );
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.retry', transfer, {
        previousStatus: transfer.status,
        newStatus: transfer.status,
        previousRefundStatus: 'failed',
        refundStatus: 'pending',
      });
    }
  });
  pokeWorker();
}
