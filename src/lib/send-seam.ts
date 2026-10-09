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
//
// Obligations of every non-bot caller (the customer portal's Send action,
// src/app/portal/send/actions.ts, meets each one; tests/portal-send-actions.test.ts):
//  - Build the ToolContext with buildToolContext, with partnerId and phone from
//    the resolved session (never from form fields) and channel 'web'.
//  - Always pass { pointer: 'web' } explicitly; never 'bot'.
//  - Pass only the consumer subset of PrepareSendInput: recipient phone + name,
//    amount + source currency, destination country and funding method. Never
//    entityType, the business names or invoiceId (the B2B shape is the bot's
//    bill flow), and never the EDD enums (recipientLegalName, relationship,
//    purpose, sourceOfFunds, occupation).
//  - Restrict fundingMethod to the consumer methods: 'ach_pull' ALONE makes a
//    send B2B here (parseB2bArgs reads funding_method).
//  - Clamp recipientName with boundUntrustedText(…, NAME_MAX), as
//    repeat_transfer does, before calling prepareSendDraft.
//  - Validate fundingMethod before getQuoteTyped: like get_quote, it does not
//    (prepareSendDraft does, over the chat funding set).
//  - Run the pure KYC-gate reads first: a gated call here mints a verification
//    inquiry (startVerificationForTurn) as a side effect. (The portal also gives
//    its context a non-minting KYC provider, so a verified customer inside the
//    T0 window never mints one either.)
//  - Run the cap + EDD pre-check first (above) and refuse on edd_required: the
//    mint only FLAGS an EDD-less transfer for review; it is a backstop, not a block.
//  - Guard a public entry point with a request key (runOnce) and a per-customer
//    rate limit, so a double submit makes one draft.

import type { Quote, CapEvaluation, CountryCode, CurrencyCode, FundingMethod } from './types';
import type { DraftPointer } from './draft-store';
import type { QuotedReward } from './rewards/types';
import { payUrlFor } from './pay-url';

export { prepareSendDraft, getQuoteTyped } from './tools';
export type { DraftPointer };
export { payUrlFor };

/**
 * The pay link the portal redirects to. The apex pay page for now (plan X2);
 * M1 H2 changes payUrlFor itself to the host's subdomain when the host tenant
 * equals the transfer's tenant.
 */
export const portalPayUrl = payUrlFor;

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
  /**
   * Batch B follow-up A3: the customer's reason for purpose `other`, ALREADY
   * decided by the caller (purpose-detail.ts decidePurpose). Kept on the draft
   * only when it is a valid reason; never on a business bill payment.
   */
  purposeDetail?: unknown;
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
      /** Step 0 FX-5: a winning partner push's expiry (epoch ms); bounds the lock line. */
      routeExpiresAt: number | undefined;
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
  /** rateDate (Step 0 §3.6): the platform rate's publication date (YYYY-MM-DD), when known. */
  | { kind: 'quote'; quote: Quote; destinationCountry: CountryCode; rateDate?: string; reward?: QuotedReward }
  | { kind: 'kyc_required'; kycUrl: string }
  /** kycUrl only when the partner's verify-before-send gate is on and the tier is T0/Suspended. */
  | { kind: 'cap'; evaluation: CapEvaluation; kycUrl?: string }
  | { kind: 'fx_unavailable'; message: string }
  | { kind: 'invalid_request'; message: string };
