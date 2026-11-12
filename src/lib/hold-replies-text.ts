/**
 * hold-replies-text — the fixed reply table itself (R30), with no runtime import.
 *
 * It lives apart from hold-replies.ts so the i18n catalogue (src/lib/i18n/catalogues/en.ts),
 * which 'use client' files bundle, can read it without pulling in hold-replies.ts's
 * server-only imports (untrusted-text.ts reaches node:url; contracts P0 rule 13).
 * hold-replies.ts re-exports FIXED_REPLIES, so every other importer reads it there,
 * and the rules in hold-replies.ts's header (no reason, no figure, a version bump on
 * any text change: HOLD_REPLIES_VERSION) apply to every entry here.
 *
 * Keep this file free of runtime imports (type imports only): tests/client-import-chain.test.ts.
 */

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
  /** The status pill of a held transfer on customer surfaces (the portal, its receipt, /account). */
  label_held: 'Processing',
  /**
   * Fix pack 3 (R13): a repeat payment this account may not set up: a closed
   * capability, a licence or a closed corridor. Never says which (no reason).
   */
  schedule_unavailable: "Repeat payments aren't available on this account right now.",
} as const;
