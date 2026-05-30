import { env } from './env';
import { completePaymentStage2 } from './payment';
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
 * Reject a held (in_review) transfer: cancel it with an admin note (mock refund).
 * Called by the compliance dashboard "Reject" action.
 * Throws if the transfer is not exactly in_review.
 */
export async function rejectTransfer(store: Store, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot reject: transfer is not in_review (current status: ${transfer.status})`);
  }
  await store.saveTransfer({
    ...transfer,
    status: 'cancelled',
    adminNote: 'rejected in review',
  });
}
