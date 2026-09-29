// schedule-validate (UI redesign M2-10): the ONE validation of a new recurring
// schedule, shared by the WhatsApp bot's create_schedule and the customer portal.
//
// validateScheduleInput is the body of createScheduleTool up to (not including)
// the save: phone → funding → frequency + day → India-only corridor → sender
// (resolveSender) → sender legal name → amount / end date → server-side payout
// (resolveStoredPayout, tombstone-aware). It lives in tools.ts beside the private
// helpers it calls (moved, not rewritten, the send-seam precedent), and the bot
// maps each refusal back to its exact old error record (pinned by
// tests/schedule-validate-golden.test.ts). This module is the public face.
//
// Two checks the bot does NOT run (today it saves any amount, and a schedule with
// no stored payout collects the account on the pay page each run). They are
// opt-in and only the portal turns them on, so the bot stays byte-identical:
//  - amountBounds: a finite amount with at most 2 decimals inside the platform
//    quote range (fx.ts MIN_USD..MAX_USD), applied to the amount as entered, BEFORE
//    the sender (and so the currency) is resolved: no FX at set-up (Task 9). The
//    run-time quote still applies the real range and the sender's own (possibly
//    lower) cap on every run.
//  - requirePayout: the payout must resolve server-side (a saved, live recipient).
//
// Obligations of every non-bot caller: build the ToolContext with
// buildToolContext, partnerId and phone from the resolved session, channel
// 'web'; take the recipient phone and name from a stored row, never a form.

import type { Schedule } from './types';

export { validateScheduleInput } from './tools';

export interface ScheduleInput {
  /** normalizePhone + isValidPhone. */
  recipientPhone: unknown;
  /** Stored as String(recipientName) (the bot passes the raw model value). */
  recipientName: unknown;
  /** Number(amount_source ?? amount_usd) — the bot passes the raw value. */
  amountSource: unknown;
  /** parseFundingArg over the consumer set; absent ⇒ bank_transfer. */
  fundingMethod?: unknown;
  /** 'weekly' ⇒ weekly; anything else ⇒ monthly. */
  frequency?: unknown;
  /** Monthly: an integer 1–28. */
  dayOfMonth?: unknown;
  /** Weekly: an integer 0 (Sunday) – 6. */
  dayOfWeek?: unknown;
  /** parseDestinationCountry; must resolve to India (or be absent with an Indian number). */
  destinationCountry?: unknown;
  /** resolveSendCurrency: a string is a request; anything else is ignored. */
  sourceCurrency?: unknown;
  /** A parseable date string, else ignored. */
  endDate?: unknown;
}

export interface ScheduleValidateOptions {
  /** Refuse an amount outside the platform range (portal only; see the header). */
  amountBounds?: boolean;
  /** Refuse when no stored payout resolves (portal only). */
  requirePayout?: boolean;
}

export type ScheduleRefusalCode =
  | 'invalid_phone'
  | 'bad_funding'
  | 'day_range'
  | 'unknown_destination'
  | 'corridor'
  | 'sender_name'
  | 'amount'
  | 'no_payout';

export type ScheduleValidateResult =
  | { ok: true; schedule: Omit<Schedule, 'id' | 'createdAt'> }
  | { ok: false; code: ScheduleRefusalCode; frequency?: 'monthly' | 'weekly' };
