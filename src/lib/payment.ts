import type { Store } from './store';
import type { CurrencyCode, Transfer } from './types';

export interface StageResult {
  transfer: Transfer;
  senderMessages: string[];
}

/**
 * Format an amount in the destination currency using Intl.NumberFormat.
 * Gives ₹ for INR, £ for GBP, AED for AED, etc.
 * Falls back to a plain numeric string if the currency code is unrecognised.
 */
export function formatDestAmount(amount: number, currency: CurrencyCode | string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * Format the source-side charge using Intl.NumberFormat.
 * Falls back to a plain numeric string for any unknown code.
 */
function formatSourceCharge(amount: number, currency: CurrencyCode | string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export async function completePaymentStage1(
  store: Store,
  transferId: string,
  opts?: { held?: boolean },
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

  const destCurrency = updated.destinationCurrency ?? 'INR';
  const destAmount = formatDestAmount(updated.amountInr, destCurrency);
  const sourceCharge = formatSourceCharge(
    updated.totalChargeSource ?? updated.totalChargeUsd,
    updated.sourceCurrency ?? 'USD',
  );

  const senderMessages = opts?.held
    ? [
        `✅ Payment received — ${sourceCharge} captured. This transfer is under a quick review; we'll confirm as soon as it's released. Transfer ID: ${updated.id}`,
      ]
    : [
        `✅ Payment received — ${sourceCharge} charged. ${updated.recipientName} will get ${destAmount} within ~10 minutes. Transfer ID: ${updated.id}`,
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

  const destCurrency = updated.destinationCurrency ?? 'INR';
  const destAmount = formatDestAmount(updated.amountInr, destCurrency);

  const senderMessages = [
    `🎉 ${destAmount} delivered to ${updated.recipientName} via bank transfer. Transfer ID: ${updated.id}. Thanks for using SmartRemit!`,
  ];

  return { transfer: updated, senderMessages };
}

export function recipientTemplateParams(transfer: Transfer): string[] {
  const destCurrency = transfer.destinationCurrency ?? 'INR';
  const destAmount = formatDestAmount(transfer.amountInr, destCurrency);
  const sender = `+${transfer.phone}`;
  return [transfer.recipientName, destAmount, sender, 'bank account'];
}
