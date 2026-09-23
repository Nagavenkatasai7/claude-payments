// Program-Fix 15 PR C — customer copy for the 30-minute sender cancellation
// (12 CFR 1005.34), as a DRAFT for counsel review (C2). Sibling of
// ./disclosure-drafts.ts, kept apart on purpose: this copy is shown AFTER
// payment (the receipt's cancel card, the bot's replies, the WhatsApp
// confirmation), so it is not part of the pre-payment disclosure the customer
// acknowledges and does not move DISCLOSURE_DRAFT_VERSION. The same rules apply:
//  - nothing here claims sign-off (tests/cancel-drafts.test.ts scans it);
//  - no compliance, screening or review wording in anything a customer sees
//    about a held transfer (no tipping-off): the held-transfer reply is neutral
//    and promises no refund;
//  - no refund promise where no refund is queued (a partner-funded charge).

import { formatSourceCharge } from '@/lib/payment';
import { isPartnerPulled } from '@/lib/funding-method';
import type { Transfer } from '@/lib/types';

/** Receipt card heading. */
export const CANCEL_CARD_TITLE = 'Cancel this transfer';

/** Receipt card body (draft). */
export const CANCEL_CARD_BODY =
  'You can cancel within 30 minutes of payment for a full refund, including fees, unless the money has already been delivered. Draft wording — for counsel review.';

/** Receipt button. `until` is a formatted time. */
export function cancelButtonLabel(until: string): string {
  return `Cancel this transfer (until ${until})`;
}

/** Receipt notices after the action (fixed codes → fixed copy; the URL never supplies text). */
export const CANCEL_NOTICE = {
  cancelled: 'This transfer is cancelled. We have sent you a confirmation on WhatsApp.',
  requested:
    'We received your cancellation request. If the money has not been delivered yet, you will get a full refund within 3 business days. Our team will confirm on WhatsApp.',
  closed: 'The 30-minute cancellation window has closed. You can still request a refund below.',
  ineligible: 'This transfer can no longer be cancelled here. Please message us on WhatsApp.',
} as const;

/** WhatsApp confirmation, enqueued in the same transaction as the cancel. */
export function buildSenderCancelMessage(transfer: Transfer, refundQueued: boolean): string {
  const charge = formatSourceCharge(transfer.totalChargeSource ?? transfer.totalChargeUsd, transfer.sourceCurrency ?? 'USD');
  const head = `Your transfer ${transfer.id} is cancelled, as you asked.`;
  if (!refundQueued) {
    return `${head} Our team will contact you shortly about your ${charge}.`;
  }
  if (isPartnerPulled(transfer.fundingMethod)) {
    return `${head} The ${charge} debit is being reversed in full, including fees, within 3 business days.`;
  }
  return `${head} We are refunding the full ${charge}, including fees, to your original payment method within 3 business days.`;
}

/** Bot reply hints (the model phrases the reply from these). */
export const CANCEL_REPLY_HINT = {
  cancelled: 'cancelled within the 30-minute window — the full amount including fees is being refunded (it arrives within 3 business days); a confirmation was sent',
  cancelledNoRefund: 'cancelled within the 30-minute window — our team will contact them about the payment',
  requested:
    'cancellation request received — if the money has not been delivered yet they get a full refund within 3 business days; our team will confirm',
  heldRequested: 'request received — our team will follow up with them about this transfer shortly',
} as const;
