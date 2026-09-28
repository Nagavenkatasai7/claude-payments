// The typed send seam (UI redesign M2-4): ONE path to a send draft and a quote,
// shared by the WhatsApp bot and the customer portal.
//
// prepareSendDraft is the body of the bot's send_approve_picker up to (not
// including) the channel-specific send: phone → funding → destination → rates →
// KYC gate → sender name → B2B bill check → cap → server-side payout lookup →
// quote + best-rate route → sanctions warm + screen (a hit records the blocked
// row with its evidence) → draft. getQuoteTyped is the body of get_quote. Both
// live in tools.ts beside the private helpers they call (moved, not rewritten),
// and the bot tools map these results back to their exact old records (pinned
// by tests/send-seam-golden.test.ts). This module is the public face: the types
// and the functions a non-bot caller imports.
//
// NOT here, on purpose: the EDD check. The bot collects EDD before the card
// (check_send_limit, then repeat_transfer's pre-check), so a non-bot caller
// must run that same pre-check itself BEFORE calling prepareSendDraft (the
// portal send action does: review round 1, M5).

import type { Quote, CapEvaluation, CountryCode, CurrencyCode, FundingMethod } from './types';
import type { DraftPointer } from './draft-store';

export { prepareSendDraft, getQuoteTyped } from './tools';
export type { DraftPointer };

/**
 * The inputs send_approve_picker reads, typed as the parser each one goes
 * through accepts. Raw model values are passed through uncoerced by the bot,
 * so each field is exactly as permissive as its parser. There is NO payout
 * field: the payout destination is resolved server-side only (the sender's own
 * saved recipient, then their own settled ledger; tools.ts resolveStoredPayout).
 */
export interface PrepareSendInput {
  /** normalizePhone + isValidPhone. */
  recipientPhone: unknown;
  /** The name screened and shown on the card (the bot passes String(args.recipient_name)). */
  recipientName: string;
  /** Number(amount_source ?? amount_usd). */
  amountSource: number;
  /** resolveSendCurrency: a string is a request; anything else is ignored. */
  sourceCurrency?: unknown;
  /** parseDestinationCountry: absent ⇒ IN unless the recipient's number says otherwise. */
  destinationCountry?: unknown;
  /** parseFundingArg over the chat funding set; absent ⇒ bank_transfer. */
  fundingMethod?: unknown;
  // ── B2B discriminators (a business bill payment; compared as today) ──
  entityType?: unknown;
  senderBusinessName?: unknown;
  recipientBusinessName?: unknown;
  invoiceId?: unknown;
  // ── Travel-Rule / EDD answers (validated enums; unknown ⇒ unsupplied) ──
  recipientLegalName?: unknown;
  relationship?: unknown;
  purpose?: unknown;
  sourceOfFunds?: unknown;
  occupation?: unknown;
}

/** Every outcome of prepareSendDraft. Each early return of the old tool is exactly one arm. */
export type PrepareSendResult =
  | {
      kind: 'draft';
      draftId: string;
      /** The approve-card summary text (as the bot shows it). */
      summary: string;
      payUrl: string;
      quote: Quote;
      recipientPhone: string;
      amountSource: number;
      sourceCurrency: CurrencyCode;
      destinationCountry: CountryCode;
      fxFetchedAt: number | undefined;
    }
  | { kind: 'invalid_phone' }
  | { kind: 'bad_funding'; message: string }
  | { kind: 'missing_destination'; message: string }
  /** A QuoteError: an unknown destination, or an amount outside the allowed range. */
  | { kind: 'invalid_request'; message: string }
  | { kind: 'fx_unavailable'; message: string }
  | { kind: 'kyc_required'; kycUrl: string }
  | { kind: 'sender_name_required' }
  /** The B2B shape without the sender's own open, seller-less bill for exactly its amount. */
  | { kind: 'bill_refused'; message: string; payUrl?: string }
  | { kind: 'cap'; evaluation: CapEvaluation }
  /** A sanctions hit. Reasonless by design: the screening detail never leaves the server. */
  | { kind: 'blocked' };

/** The inputs get_quote reads. */
export interface QuoteTypedInput {
  sourceCurrency?: unknown;
  destinationCountry?: unknown;
  /** Receive-first target in the destination currency (amount_dest ?? amount_inr). */
  amountDest?: unknown;
  /** Send amount (amount_source ?? amount_usd). */
  amountSource?: unknown;
  fundingMethod?: FundingMethod;
}

export type QuoteTypedResult =
  | { kind: 'quote'; quote: Quote; destinationCountry: CountryCode }
  | { kind: 'kyc_required'; kycUrl: string }
  /** kycUrl only when the partner's verify-before-send gate is on and the tier is T0/Suspended. */
  | { kind: 'cap'; evaluation: CapEvaluation; kycUrl?: string }
  | { kind: 'fx_unavailable'; message: string }
  | { kind: 'invalid_request'; message: string };
