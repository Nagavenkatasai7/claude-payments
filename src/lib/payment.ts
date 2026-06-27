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

/**
 * Whether this transfer should use the B2B / ACH-pull wording. True when the
 * transfer is explicitly B2B, OR it's funded by an ACH debit of a business bank
 * account ('ach_pull'). Consumer (b2c card/bank) transfers fall through to the
 * byte-identical consumer copy.
 */
function isBusinessFunded(transfer: Transfer): boolean {
  return transfer.transferType === 'b2b' || transfer.fundingMethod === 'ach_pull';
}

/**
 * The recipient label for the B2B charge/delivery line: prefer the recipient's
 * business name when it's a business AND the name is fully present (not the
 * masked `****last4` placeholder — never name the mask), else fall back to the
 * display recipient name.
 */
function recipientLabel(transfer: Transfer): string {
  const biz = transfer.recipientBusinessName;
  if (transfer.recipientEntityType === 'business' && biz && !biz.startsWith('****')) {
    return biz;
  }
  return transfer.recipientName;
}

/**
 * The customer-facing stage-1 ("payment received") message — pure, so the
 * transactional settlement path (Stage 2c) can enqueue the EXACT text that
 * completePaymentStage1 would have sent.
 *
 * B2B / ACH-pull (`transferType==='b2b'` or `fundingMethod==='ach_pull'`) gets
 * "debited from your business account" wording; the consumer (b2c) shape is
 * byte-identical to before. The raw bank account is NEVER named in either case.
 */
export function buildStage1Message(transfer: Transfer, opts?: { held?: boolean }): string {
  const destCurrency = transfer.destinationCurrency ?? 'INR';
  const destAmount = formatDestAmount(transfer.amountInr, destCurrency);
  const sourceCharge = formatSourceCharge(
    transfer.totalChargeSource ?? transfer.totalChargeUsd,
    transfer.sourceCurrency ?? 'USD',
  );

  if (isBusinessFunded(transfer)) {
    return opts?.held
      ? `✅ Payment received — ${sourceCharge} will be debited from your business account. This transfer is under a quick review; we'll confirm as soon as it's released. Transfer ID: ${transfer.id}`
      : `✅ Payment received — ${sourceCharge} will be debited from your business account. ${recipientLabel(transfer)} will receive ${destAmount} within ~10 minutes. Transfer ID: ${transfer.id}`;
  }

  return opts?.held
    ? `✅ Payment received — ${sourceCharge} captured. This transfer is under a quick review; we'll confirm as soon as it's released. Transfer ID: ${transfer.id}`
    : `✅ Payment received — ${sourceCharge} charged. ${transfer.recipientName} will get ${destAmount} within ~10 minutes. Transfer ID: ${transfer.id}`;
}

/**
 * The customer-facing refund confirmation — pure, enqueued by the worker's
 * funding.refund handler in the same transaction as the refund-completed flip.
 * The amount is the FULL source-side charge (what the funding provider
 * captured). NEVER mentions why: compliance reasons stay internal.
 */
export function buildRefundMessage(transfer: Transfer): string {
  const sourceCharge = formatSourceCharge(
    transfer.totalChargeSource ?? transfer.totalChargeUsd,
    transfer.sourceCurrency ?? 'USD',
  );
  // NON-CUSTODIAL B2B ach_pull: we never captured funds, so this is a REVERSAL of
  // the partner's ACH debit, not a SmartRemit refund — the wording must not imply
  // we refunded to a card/payment method.
  if (transfer.fundingMethod === 'ach_pull') {
    return (
      `Your bill payment ${transfer.id} has been cancelled. The ${sourceCharge} ` +
      `ACH debit to your business account is being reversed — it typically clears ` +
      `in 3-5 business days.`
    );
  }
  return (
    `Your transfer ${transfer.id} could not be completed. We've refunded ` +
    `${sourceCharge} to your original payment method — it typically arrives ` +
    `in 3-5 business days.`
  );
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

  return { transfer: updated, senderMessages: [buildStage1Message(updated, opts)] };
}

export async function completePaymentStage2(
  store: Store,
  transferId: string,
  opts?: { brand?: string }, // WL1: end-customer-facing brand; absent ⇒ 'SmartRemit'
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

  // MONEY SAFETY: do not deliver a transfer with a refund in progress. Once a
  // refund is requested/pending/completed/failed the money is being returned to
  // the sender — paying the recipient as well would move the money twice (sender
  // refunded AND recipient paid). refundStatus defaults to 'none'.
  if ((transfer.refundStatus ?? 'none') !== 'none') {
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

  const brand = opts?.brand?.trim() || 'SmartRemit';
  const senderMessages = [
    `🎉 ${destAmount} delivered to ${updated.recipientName} via bank transfer. Transfer ID: ${updated.id}. Thanks for using ${brand}!`,
  ];

  return { transfer: updated, senderMessages };
}

// DO NOT CHANGE — matches the LIVE approved transfer_delivered template (old
// 4-param order: recipient name, dest amount, sender, account-label). The
// multi-currency rebuild to a new 4-param order per docs/meta-whatsapp-config.md
// §3.1 is a coordinated step the user does later (re-approve in WhatsApp Manager
// first, then swap params here in lockstep).
export function recipientTemplateParams(transfer: Transfer): string[] {
  const destCurrency = transfer.destinationCurrency ?? 'INR';
  const destAmount = formatDestAmount(transfer.amountInr, destCurrency);
  const sender = `+${transfer.phone}`;
  return [transfer.recipientName, destAmount, sender, 'bank account'];
}

// Free-form fallback for the recipient's "money delivered" notification. The
// approved `transfer_delivered` TEMPLATE is what reaches a recipient OUTSIDE the
// 24h window, but a bare template send fails silently if Meta rejects it (params,
// approval, language) — leaving the recipient with nothing while the sender (a
// free-form text in an open window) is notified. So we degrade to this text if
// the template throws; it delivers whenever the recipient has an open window.
export function recipientDeliveredFallbackText(transfer: Transfer, brand = 'SmartRemit'): string {
  const destCurrency = transfer.destinationCurrency ?? 'INR';
  const destAmount = formatDestAmount(transfer.amountInr, destCurrency);
  const sender = `+${transfer.phone}`;
  return (
    `💰 ${transfer.recipientName}, you've received ${destAmount} from ${sender} via ${brand}. ` +
    `It's on the way to your bank account.`
  );
}
