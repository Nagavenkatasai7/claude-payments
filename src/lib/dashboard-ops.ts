import { env } from './env';
import { completePaymentStage2 } from './payment';
import { pokeWorker } from './outbox';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';
import type { Store } from './store';

export async function cancelTransfer(store: Store, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status === 'delivered' || transfer.status === 'cancelled') {
    return;
  }
  await store.saveTransfer({ ...transfer, status: 'cancelled' });
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
  await store.saveTransfer({ ...transfer, assignedTo: assignee, adminNote: note });
}

export async function resendPaymentLink(
  store: Store,
  sendText: (to: string, text: string) => Promise<void>,
  id: string,
): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  const url = `${env.appBaseUrl}/pay/${id}`;
  await sendText(transfer.phone, `Here is your secure payment link again: ${url}`);
}

/**
 * Release a held (in_review) transfer: run stage 2 delivery.
 * Called by the compliance dashboard "Release" action.
 * Throws if the transfer is not exactly in_review (guards double-release/wrong-status).
 */
export async function releaseTransfer(store: Store, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot release: transfer is not in_review (current status: ${transfer.status})`);
  }
  await completePaymentStage2(store, id);
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
export async function rejectTransfer(store: Store, db: Db, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot reject: transfer is not in_review (current status: ${transfer.status})`);
  }
  const cancelled = { ...transfer, status: 'cancelled' as const, adminNote: 'rejected in review' };
  if (!transfer.fundingRef) {
    // Uncharged legacy rows: cancel-only — there is no charge to return.
    await store.saveTransfer(cancelled);
    return;
  }
  // CHARGED: the cancel, the refund-pending flip and the durable funding.refund
  // effect commit in ONE transaction — a crash can never leave a cancelled,
  // charged, UNREFUNDED transfer (a state no sweep watches). none → pending is
  // a legal move; a replayed reject is blocked upstream by the in_review check,
  // and the dedupe key blocks a duplicate effect.
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    await repo.saveTransfer(cancelled);
    await repo.updateRefund(id, { refundStatus: 'pending' });
    await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}` },
    );
  });
  pokeWorker(); // fast path — the heartbeat is the guarantee
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
export async function issueRefund(db: Db, id: string): Promise<void> {
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
  });
  pokeWorker();
}

/**
 * Approve a CUSTOMER-REQUESTED refund: requested → pending + the durable
 * funding.refund effect, one transaction. The state is re-checked inside the
 * transaction, so a double-click (or a refund never requested) throws and
 * enqueues nothing — refunds are never minted from thin air.
 */
export async function approveRefund(db: Db, id: string): Promise<void> {
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
  });
  pokeWorker();
}

/**
 * Dismiss a CUSTOMER-REQUESTED refund: requested → none + an adminNote trail.
 * The guarded updateRefund (legal only from 'requested') is the gate — an
 * in-flight or completed refund can never be "dismissed" away.
 */
export async function dismissRefund(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const updated = await repo.updateRefund(id, { refundStatus: 'none' });
    if (!updated) {
      throw new Error('Cannot dismiss: refund is not awaiting approval.');
    }
    await repo.saveTransfer({ ...updated, adminNote: 'refund request dismissed' });
  });
}

/**
 * Retry a FAILED refund: failed → pending + a fresh funding.refund effect.
 * The original `refund:<id>` dedupe key is spent (that row ran and the
 * provider reported failure), so each retry mints a unique key — while the
 * failed-state check inside the transaction keeps double-clicks to one.
 */
export async function retryRefund(db: Db, id: string): Promise<void> {
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
  });
  pokeWorker();
}
