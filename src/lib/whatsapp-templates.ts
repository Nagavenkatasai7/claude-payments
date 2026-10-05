// Template-ready param builders for the business-initiated (outside-24h-window)
// WhatsApp messages specified in docs/meta-whatsapp-config.md §3. All UTILITY,
// language code 'en'. These templates are NOT yet approved in WhatsApp Manager —
// every send wired to them must fall back to free-form sendText on failure (see
// sendTemplateOrText in ./whatsapp). This module is PURE: constants + ordered
// param builders only — no fetch, no Redis. Keeping it pure means the §3 param
// order is unit-testable without any network mock.

import type { CurrencyCode, Schedule, Transfer } from './types';
import { DEFAULT_BRAND } from './partner-config';
import { NAME_MAX, safeDisplayText } from './untrusted-text';

/** Program-Fix 49A: a blank/absent brand falls back to the SmartRemit default. */
function brandOr(brand: string | undefined): string {
  return brand?.trim() || DEFAULT_BRAND;
}

/**
 * A recipient name as it may appear in a template param or a business message:
 * the same cleaning as recipientDisplayName (payment.ts) — web-address tokens
 * stripped so an outsider-written name never becomes a link inside a
 * business-verified message — and never empty (Meta rejects an empty param).
 */
function recipientOr(name: string | undefined): string {
  return safeDisplayText(name, NAME_MAX) || 'your recipient';
}

// All new UTILITY templates use language code 'en' — matches the live
// transfer_delivered template (created as "English" => 'en', not 'en_US').
export const TEMPLATE_LANG = 'en';

// Exact template names per docs/meta-whatsapp-config.md §3.2–§3.8.
export const TEMPLATE_TRANSFER_DELIVERED_SENDER = 'transfer_delivered_sender'; // §3.2
export const TEMPLATE_SCHEDULED_PAYMENT_READY = 'scheduled_payment_ready';     // §3.3
export const TEMPLATE_PAYMENT_REMINDER = 'payment_reminder';                   // §3.4
export const TEMPLATE_TRANSFER_IN_REVIEW = 'transfer_in_review';               // §3.5
export const TEMPLATE_TRANSFER_RELEASED = 'transfer_released';                 // §3.6
export const TEMPLATE_TRANSFER_CANCELLED = 'transfer_cancelled';              // §3.7
export const TEMPLATE_VERIFICATION_REMINDER = 'verification_reminder';        // §3.8
// 2026-10-03: the scheduled-send legal-name nudge (owner-steps guide B5 body).
export const TEMPLATE_SCHEDULE_NAME_NEEDED = 'schedule_name_needed';

/**
 * Ordered body params plus the single dynamic URL-button suffix token, for the
 * templates whose §3 spec includes a "Visit website" Dynamic button
 * (scheduled_payment_ready §3.3, payment_reminder §3.4, verification_reminder §3.8).
 * `buttonToken` is the `{{1}}` suffix appended to the button URL (e.g. /pay/{{1}}),
 * so it MUST be a path-safe slug — no '/' or query chars (§3 dynamic-URL rule).
 */
export interface TemplateWithButton {
  bodyParams: string[];
  buttonToken: string;
}

// ── Meta AUTHENTICATION-template OTP (spec §3c) ──
// The approved AUTHENTICATION template carries the one-time code in BOTH the
// message body AND the COPY_CODE url button — Meta requires the same {{1}} in
// each. This builder emits the Graph API `components` array for that send. PURE:
// no fetch, no Redis, no logging — so the param shape is unit-testable and the
// code never touches I/O here. NEVER log the returned value.

/** A single text parameter as the Graph API expects: { type: 'text', text }. */
export interface TemplateTextParameter {
  type: 'text';
  text: string;
}

/** One Graph API template component (body or the COPY_CODE url button). */
export interface AuthenticationTemplateComponent {
  type: 'body' | 'button';
  sub_type?: 'url';
  index?: string;
  parameters: TemplateTextParameter[];
}

/**
 * Build the `components` array for an AUTHENTICATION-template OTP send. The code
 * is placed in the body param AND the url button (sub_type 'url', index '0') so
 * the WhatsApp copy-code button copies the exact same code shown in the body.
 * The code is passed as a STRING so leading zeros survive (CSPRNG codes can
 * start with 0). Caller: sendOtpCode in ./whatsapp — never log this.
 */
export function authenticationTemplateParams(
  code: string,
): AuthenticationTemplateComponent[] {
  return [
    {
      type: 'body',
      parameters: [{ type: 'text', text: code }],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: code }],
    },
  ];
}

/**
 * Format the source-side charge (the sender's amount, e.g. $50.00) — always
 * 2 decimal places with the currency symbol, matching the §3 samples
 * ($50.00 / $100.00 / $1,000.00). Mirrors the module-private formatSourceCharge
 * in ./payment (kept here so payment.ts stays untouched), including the
 * fallback for an unrecognised currency code.
 */
export function formatSourceAmount(amount: number, currency: CurrencyCode | string): string {
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

const DUE_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

/**
 * Scheduled-send name nudge (2026-10-02): free-form text. Outside the customer's
 * 24-hour window the cron sends the schedule_name_needed template instead
 * (2026-10-03; until Meta approves it, this text goes either way). Fixed copy with
 * the partner's brand and the source amount only, never the recipient's
 * outsider-written name. `dueAt` is any instant on the Eastern due day.
 */
export function scheduleNameNeededText(
  brand: string,
  schedule: Pick<Schedule, 'amountUsd' | 'amountSource' | 'sourceCurrency'>,
  timing: { dueToday: boolean; dueAt: number },
): string {
  const amount = formatSourceAmount(schedule.amountSource ?? schedule.amountUsd, schedule.sourceCurrency ?? 'USD');
  return timing.dueToday
    ? `Your scheduled ${brand} transfer of ${amount} couldn't go out today because we need your full legal name first. ` +
        `Reply here with your full name as on your ID and we'll send your payment link on the next scheduled run.`
    : `Your scheduled ${brand} transfer of ${amount} is due on ${DUE_DAY.format(timing.dueAt)}. Before then we need your full legal name. ` +
        `Reply here with your full name as on your ID so it can go out on time.`;
}

/**
 * schedule_name_needed — the scheduled-send legal-name nudge as a template.
 * Body: "Your scheduled {{1}} transfer of {{2}}, due {{3}}, needs your full
 * legal name before it can go out. Please reply to this message with your full
 * name exactly as it appears on your ID."
 * Params: [brand, source amount, due day]. Never the recipient's name.
 */
export function scheduleNameNeededParams(
  brand: string,
  schedule: Pick<Schedule, 'amountUsd' | 'amountSource' | 'sourceCurrency'>,
  dueAt: number,
): string[] {
  return [
    brandOr(brand),
    formatSourceAmount(schedule.amountSource ?? schedule.amountUsd, schedule.sourceCurrency ?? 'USD'),
    DUE_DAY.format(dueAt),
  ];
}

/** The ready-to-send template for the scheduled-send legal-name nudge. */
export function scheduleNameNeededTemplate(
  brand: string,
  schedule: Pick<Schedule, 'amountUsd' | 'amountSource' | 'sourceCurrency'>,
  dueAt: number,
): { name: string; lang: string; params: string[] } {
  return { name: TEMPLATE_SCHEDULE_NAME_NEEDED, lang: TEMPLATE_LANG, params: scheduleNameNeededParams(brand, schedule, dueAt) };
}

/** The ready-to-send template for the sender's "delivered" notice (§3.2). */
export function deliveredSenderTemplate(transfer: Transfer): { name: string; lang: string; params: string[] } {
  return { name: TEMPLATE_TRANSFER_DELIVERED_SENDER, lang: TEMPLATE_LANG, params: transferDeliveredSenderParams(transfer) };
}

/**
 * The ready-to-send template for the held ("in review") notice (§3.5). The
 * ledger row carries no sender name, so {{1}} is "there" ("Hi there, …").
 */
export function inReviewTemplate(transfer: Transfer): { name: string; lang: string; params: string[] } {
  return { name: TEMPLATE_TRANSFER_IN_REVIEW, lang: TEMPLATE_LANG, params: transferInReviewParams(transfer, 'there') };
}

/**
 * §3.2 transfer_delivered_sender — sender delivery confirmation.
 * Body: "Your SmartRemit transfer of {{1}} to {{2}} has been delivered. Reference: {{3}}. Reply here if you have any questions."
 * Params: [source amount, recipient name, transfer id]. No button.
 */
export function transferDeliveredSenderParams(transfer: Transfer): string[] {
  return [
    formatSourceAmount(
      transfer.totalChargeSource ?? transfer.totalChargeUsd,
      transfer.sourceCurrency ?? 'USD',
    ),
    recipientOr(transfer.recipientName),
    transfer.id,
  ];
}

const SET_UP_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

/**
 * The day a schedule was set up, e.g. "September 3, 2026" (Eastern), so a
 * reminder names the customer's own schedule. 2026-10-03: a tester who had
 * forgotten an old schedule read its reminder as another customer's message.
 * An unparseable createdAt degrades to "an earlier date", never "Invalid Date".
 */
export function scheduleSetUpDay(createdAt: string): string {
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? SET_UP_DAY.format(ms) : 'an earlier date';
}

/**
 * §3.3 scheduled_payment_ready — recurring-transfer approval with pay link.
 * Body: "Hi {{1}}, your {{2}} scheduled transfer of {{3}} to {{4}} is ready.
 * You set up this schedule on {{5}}. Tap the button below to review and pay,
 * or reply "cancel schedule" to stop it."
 * Button URL suffix {{1}} = the pay token (the freshly created transfer's id).
 * Params: body [sender name, frequency, amount, recipient, set-up day], button token = transferId.
 */
export function scheduledPaymentReadyParams(
  schedule: Schedule,
  transferId: string,
  senderName: string,
): TemplateWithButton {
  return {
    bodyParams: [
      senderName,
      schedule.frequency,
      formatSourceAmount(schedule.amountSource ?? schedule.amountUsd, schedule.sourceCurrency ?? 'USD'),
      recipientOr(schedule.recipientName),
      scheduleSetUpDay(schedule.createdAt),
    ],
    buttonToken: transferId,
  };
}

/**
 * The free-form twin of scheduled_payment_ready, sent until the template is
 * approved (and in-window only). Says which of the customer's schedules this
 * is, when they set it up, and how to stop it (the bot's cancel_schedule).
 */
export function scheduledPaymentReadyText(brand: string, schedule: Schedule, url: string): string {
  const amount = formatSourceAmount(schedule.amountSource ?? schedule.amountUsd, schedule.sourceCurrency ?? 'USD');
  return (
    `Your ${schedule.frequency} scheduled ${brandOr(brand)} transfer of ${amount} to ${recipientOr(schedule.recipientName)} is ready. ` +
    `You set up this schedule on ${scheduleSetUpDay(schedule.createdAt)}. Tap to pay: ${url}\n\n` +
    `To stop this schedule, reply "cancel schedule".`
  );
}

/**
 * §3.4 payment_reminder — abandoned/unpaid transfer nudge with pay link.
 * Body: "Hi {{1}}, your transfer of {{2}} to {{3}} is still pending..."
 * Button URL suffix {{1}} = the pay token (transfer.id).
 * Params: body [sender name, amount, recipient], button token = transfer.id.
 */
export function paymentReminderParams(transfer: Transfer, senderName: string): TemplateWithButton {
  return {
    bodyParams: [
      senderName,
      formatSourceAmount(
        transfer.totalChargeSource ?? transfer.totalChargeUsd,
        transfer.sourceCurrency ?? 'USD',
      ),
      recipientOr(transfer.recipientName),
    ],
    buttonToken: transfer.id,
  };
}

// §3.5/§3.6/§3.7 share the same body shape: [sender name, amount, recipient].
function senderAmountRecipientParams(transfer: Transfer, senderName: string): string[] {
  return [
    senderName,
    formatSourceAmount(
      transfer.totalChargeSource ?? transfer.totalChargeUsd,
      transfer.sourceCurrency ?? 'USD',
    ),
    recipientOr(transfer.recipientName),
  ];
}

/** §3.5 transfer_in_review — compliance hold. Params: [name, amount, recipient]. */
export function transferInReviewParams(transfer: Transfer, senderName: string): string[] {
  return senderAmountRecipientParams(transfer, senderName);
}

/** §3.6 transfer_released — cleared after review. Params: [name, amount, recipient]. */
export function transferReleasedParams(transfer: Transfer, senderName: string): string[] {
  return senderAmountRecipientParams(transfer, senderName);
}

/** §3.7 transfer_cancelled — could not be completed. Params: [name, amount, recipient]. */
export function transferCancelledParams(transfer: Transfer, senderName: string): string[] {
  return senderAmountRecipientParams(transfer, senderName);
}

/**
 * §3.8 verification_reminder — pending-verification nudge with KYC link.
 * Body: "Hi {{1}}, identity verification is still pending..."
 * Button URL suffix {{1}} = the KYC/verify session token (path-safe slug).
 * Params: body [sender name], button token = sessionToken.
 */
export function verificationReminderParams(senderName: string, sessionToken: string): TemplateWithButton {
  return {
    bodyParams: [senderName],
    buttonToken: sessionToken,
  };
}

// ── Phase 2: KYC verification status (one template per state; degrade to
// free-form via sendTemplateOrText until Meta approves them). Params: [name, message]. ──
export type VerificationState = 'needed' | 'in_progress' | 'received' | 'verified' | 'failed';

const VERIFICATION_STATUS_MESSAGES: Record<VerificationState, string> = {
  needed: 'Please verify your identity to start sending money.',
  in_progress: 'Your identity verification is in progress.',
  received: 'Thanks — we received your verification and are reviewing it. We’ll message you shortly.',
  verified: 'You’re verified! You can now send money.',
  failed: 'We couldn’t verify your identity. Please tap below to try again.',
};

export function verificationStatusParams(name: string, state: VerificationState): string[] {
  return [name || 'there', VERIFICATION_STATUS_MESSAGES[state]];
}

// Free-form fallback when no template is configured. The template params above
// are a Meta contract ({{1}}=name, {{2}}=message) and read fine inside the
// approved body copy; concatenating them raw produced "there, Your identity…".
export function verificationStatusFallbackText(
  name: string | undefined,
  state: VerificationState,
): string {
  const msg = VERIFICATION_STATUS_MESSAGES[state];
  const trimmed = name?.trim();
  return trimmed ? `Hi ${trimmed} — ${msg}` : msg;
}

/**
 * Phase 3: the per-transaction step-up OTP message. Delivered IN-SESSION as
 * free-form text (the customer is actively paying → inside the 24-h window), so
 * it needs no AUTHENTICATION template. Pure (testable); the code is interpolated
 * by the caller and must never be logged.
 *
 * Program-Fix 45: ends with the "never share" line. `brand` is optional (every
 * caller today sends the SmartRemit default); a blank brand falls back to it.
 */
export function transactionOtpMessage(code: string, brand?: string): string {
  const name = brandOr(brand);
  return (
    `Your ${name} confirmation code is ${code}. Enter it on the payment page to send this transfer. ` +
    `It expires in 10 minutes. Never share this code; ${name} will never ask for it.`
  );
}

/**
 * Account verification OTP (register / login step-up / password reset). The
 * approved Meta AUTHENTICATION template is preferred, but until it's live this
 * free-form text is the in-session fallback so a customer still receives the
 * code. Pure (testable); the code is interpolated by the caller and must never
 * be logged. `brand` (Program-Fix 49A): the owning partner's name; absent ⇒ SmartRemit.
 */
export function otpMessage(code: string, brand?: string): string {
  return `Your ${brandOr(brand)} verification code is ${code}. It expires in 5 minutes. Don't share it with anyone.`;
}
