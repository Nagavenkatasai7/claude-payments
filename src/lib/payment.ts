import type { Store } from './store';
import type { Transfer } from './types';

export interface PaymentResult {
  transfer: Transfer;
  messages: string[];
}

function inr(amount: number): string {
  return amount.toLocaleString('en-IN');
}

export async function completePayment(
  store: Store,
  transferId: string,
): Promise<PaymentResult> {
  const transfer = await store.getTransfer(transferId);
  if (!transfer) {
    throw new Error(`Transfer not found: ${transferId}`);
  }
  if (transfer.status === 'delivered') {
    return { transfer, messages: [] };
  }

  const now = new Date().toISOString();
  const updated: Transfer = {
    ...transfer,
    status: 'delivered',
    paidAt: transfer.paidAt ?? now,
    deliveredAt: now,
  };
  await store.saveTransfer(updated);

  const method = updated.payoutMethod === 'upi' ? 'UPI' : 'bank transfer';
  const messages = [
    `✅ Payment received — $${updated.totalChargeUsd.toFixed(
      2,
    )} charged. Converting to rupees…`,
    `🎉 ₹${inr(updated.amountInr)} delivered to ${
      updated.recipientName
    } via ${method}. Thanks for using SendHome!`,
  ];
  return { transfer: updated, messages };
}
