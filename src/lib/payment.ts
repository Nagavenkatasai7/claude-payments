import type { Store } from './store';
import type { Transfer } from './types';

export interface StageResult {
  transfer: Transfer;
  senderMessages: string[];
}

function inr(amount: number): string {
  return amount.toLocaleString('en-IN');
}

export async function completePaymentStage1(
  store: Store,
  transferId: string,
): Promise<StageResult> {
  const transfer = await store.getTransfer(transferId);
  if (!transfer) {
    throw new Error(`Transfer not found: ${transferId}`);
  }

  // Idempotent: already past this stage
  if (transfer.status === 'paid' || transfer.status === 'delivered') {
    return { transfer, senderMessages: [] };
  }

  const now = new Date().toISOString();
  const updated: Transfer = {
    ...transfer,
    status: 'paid',
    paidAt: now,
  };
  await store.saveTransfer(updated);

  const senderMessages = [
    `✅ Payment received — $${updated.totalChargeUsd.toFixed(2)} charged. Sending ₹${inr(updated.amountInr)} to ${updated.recipientName}…`,
  ];

  return { transfer: updated, senderMessages };
}

export async function completePaymentStage2(
  store: Store,
  transferId: string,
): Promise<StageResult> {
  const transfer = await store.getTransfer(transferId);
  if (!transfer) {
    throw new Error(`Transfer not found: ${transferId}`);
  }

  // Idempotent: already delivered
  if (transfer.status === 'delivered') {
    return { transfer, senderMessages: [] };
  }

  // Do not deliver a cancelled transfer
  if (transfer.status === 'cancelled') {
    return { transfer, senderMessages: [] };
  }

  const now = new Date().toISOString();
  const updated: Transfer = {
    ...transfer,
    status: 'delivered',
    paidAt: transfer.paidAt ?? now,
    deliveredAt: now,
  };
  await store.saveTransfer(updated);

  const senderMessages = [
    `🎉 ₹${inr(updated.amountInr)} delivered to ${updated.recipientName}. Thanks for using SendHome!`,
  ];

  return { transfer: updated, senderMessages };
}

export function recipientTemplateParams(transfer: Transfer): string[] {
  const amountInr = transfer.amountInr.toLocaleString('en-IN');
  const sender = `+${transfer.phone}`;
  const destination = transfer.payoutMethod === 'upi' ? 'UPI ID' : 'bank account';
  return [transfer.recipientName, amountInr, sender, destination];
}
