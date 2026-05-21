import type { Store } from './store';
import type { Transfer } from './types';

export interface StageResult {
  transfer: Transfer;
  senderMessages: string[];
  recipientMessages: string[];
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
    return { transfer, senderMessages: [], recipientMessages: [] };
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

  const destination =
    updated.payoutMethod === 'upi' ? 'UPI ID' : 'bank account';
  const recipientMessages = [
    `Hi ${updated.recipientName}! 💸 ₹${inr(updated.amountInr)} is on its way to you via SendHome — it will reach your ${destination} within 10 minutes.`,
  ];

  return { transfer: updated, senderMessages, recipientMessages };
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
    return { transfer, senderMessages: [], recipientMessages: [] };
  }

  // Do not deliver a cancelled transfer
  if (transfer.status === 'cancelled') {
    return { transfer, senderMessages: [], recipientMessages: [] };
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
  const recipientMessages = [
    `🎉 ₹${inr(updated.amountInr)} has landed in your account. All done!`,
  ];

  return { transfer: updated, senderMessages, recipientMessages };
}
