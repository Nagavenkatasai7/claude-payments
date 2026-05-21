import { env } from './env';
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
