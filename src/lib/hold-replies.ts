import { boundUntrustedText } from './untrusted-text';

/**
 * hold-replies — the ONLY source of the fixed text a customer is shown when a
 * transfer is held, cannot go ahead, needs more details, or is over a sending
 * limit (R30, no tipping-off). The WhatsApp bot, the web chat, the customer
 * portal and the AI-app (MCP) server all read their wording here, so one
 * approved version covers every surface. Support staff use the same scripts.
 *
 * Why the wording is fixed: the Bank Secrecy Act forbids telling anyone that a
 * suspicious activity report was or may be filed (31 U.S.C. 5318(g)(2)). A
 * reply that names a review, a screening result or a threshold, or that says
 * exactly how much is left today, lets a customer probe what triggers a hold.
 *
 * Rules every entry follows (tests/hold-replies.test.ts runs a banned-word check
 * over the whole table):
 *  - no reason: never a review, a report, a screening result or a flag;
 *  - no figure: no digit and no currency sign, so no threshold, no limit and
 *    no remaining amount;
 *  - later changes ADD entries here and never write hold or limit text elsewhere.
 *
 * The HELP suffix, the receipt link and the licensed-provider line are
 * parameters (FixedReplyOptions), so a later change to any of them is one edit.
 */

/** The wording version the partner's compliance officer (MLRO) approves. Bump it on any text change. */
export const HOLD_REPLIES_VERSION = '2026-10-31.1 (draft, awaiting MLRO approval)';

export const FIXED_REPLIES = {
  /** A paid transfer that is held before payout (status in_review). */
  hold: "Your transfer is being processed. We'll message you as soon as there is an update. You don't need to do anything right now.",
  /** A transfer that cannot go ahead (it was never charged). */
  block: "This transfer can't be completed, and you have not been charged.",
  /** Before the approval card: the two extra questions (source of funds and occupation). */
  edd_ask: 'Before this transfer we need two quick details: where the money comes from, and your occupation.',
  /** The same two questions, on a surface that cannot ask them (web chat, portal, AI apps). */
  edd_elsewhere:
    'This transfer needs a couple of extra details that can only be given in our WhatsApp chat. Message us on WhatsApp to finish it.',
  /** Over the daily sending cap. */
  cap_daily: 'This is more than you can send today. You can send a smaller amount, or try again on another day.',
  /** Over the per-transfer cap. */
  cap_per_transfer: 'This is more than you can send in one transfer. You can send a smaller amount.',
  /** The intro window ended without a verified identity. */
  cap_verify: 'Please verify your identity to keep sending.',
  /** Sending is switched off for this customer (for example a failed verification). */
  cap_unavailable: 'Sending is not available on this account right now.',
  /** Any other refusal of a send. */
  cannot_complete: "This transfer can't be completed right now.",
  /** A refund asked for while the transfer is held. */
  refund_while_held: "A refund can't be requested for this transfer yet. We'll message you as soon as there is an update.",
  /** A held business bill payment (B2B), for example when the buyer asks to cancel it. */
  payment_held: "This payment is being processed. We'll message you as soon as there is an update.",
  /** The status label of a held transfer, inside a list or a sentence. */
  status_held: "processing, we'll message you",
  /** The held step on a transfer's timeline (the customer portal). */
  timeline_held: "Processing. We'll message you as soon as there is an update.",
} as const;

export type FixedReplyKind = keyof typeof FIXED_REPLIES;

/** The fixed text for a held transfer. */
export const HOLD_REPLY: string = FIXED_REPLIES.hold;
/** The fixed text for a transfer that cannot go ahead. */
export const BLOCK_REPLY: string = FIXED_REPLIES.block;
/** The fixed explanation before the two extra questions. */
export const EDD_ASK: string = FIXED_REPLIES.edd_ask;

/** Points the customer to a person. One place to change it (R43 moves it to the HELP keyword). */
export const HELP_SUFFIX = "If you'd like help, say you'd like to talk to a person.";

const RECEIPT_LABEL = 'Receipt:';
const RECEIPT_MAX = 300;
const PROVIDER_LINE_MAX = 200;

export interface FixedReplyOptions {
  /** Append HELP_SUFFIX (a way out on every dead end). */
  help?: boolean;
  /** A receipt link made by our code, added on its own line. */
  receiptUrl?: string;
  /** The licensed-provider line ("Payments by <partner>, licensed by <regulator>"); empty until PR4. */
  providerLine?: string;
}

/**
 * One fixed reply with its optional parts, always in this order: the entry, the
 * HELP suffix, then the receipt link and the provider line on their own lines.
 * Blank parameters add nothing. The receipt link and the provider line are
 * flattened to one line each, so neither can add lines of its own.
 */
export function fixedReply(kind: FixedReplyKind, opts: FixedReplyOptions = {}): string {
  let text: string = FIXED_REPLIES[kind];
  if (opts.help) text = `${text} ${HELP_SUFFIX}`;
  const receipt = boundUntrustedText(opts.receiptUrl, RECEIPT_MAX).trim();
  if (receipt) text = `${text}\n${RECEIPT_LABEL} ${receipt}`;
  const provider = boundUntrustedText(opts.providerLine, PROVIDER_LINE_MAX).trim();
  if (provider) text = `${text}\n${provider}`;
  return text;
}

/** Which fixed reply a cap refusal reason (tier-rules.ts CapReason) gets. Unknown ⇒ cannot_complete. */
export function capRefusalKind(reason: unknown): FixedReplyKind {
  switch (reason) {
    case 'over_daily_cap':
      return 'cap_daily';
    case 'over_per_transfer_cap':
      return 'cap_per_transfer';
    case 'verification_required_after_window':
      return 'cap_verify';
    case 'verification_rejected':
      return 'cap_unavailable';
    default:
      return 'cannot_complete';
  }
}

/** The fixed refusal for a cap reason: no figure, no reason beyond the plain kind. */
export function capRefusalReply(reason: unknown, opts: FixedReplyOptions = {}): string {
  return fixedReply(capRefusalKind(reason), opts);
}
