// Template-ready param builders for the business-initiated (outside-24h-window)
// WhatsApp messages specified in docs/meta-whatsapp-config.md §3. All UTILITY,
// language code 'en'. These templates are NOT yet approved in WhatsApp Manager —
// every send wired to them must fall back to free-form sendText on failure (see
// sendTemplateOrText in ./whatsapp). This module is PURE: constants + ordered
// param builders only — no fetch, no Redis. Keeping it pure means the §3 param
// order is unit-testable without any network mock.

import type { CurrencyCode, Schedule, Transfer } from './types';

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

/**
 * §3.2 transfer_delivered_sender — sender delivery confirmation.
 * Body: "Your SmartRemit transfer of {{1}} to {{2}} has been delivered. Reference: {{3}}."
 * Params: [source amount, recipient name, transfer id]. No button.
 */
export function transferDeliveredSenderParams(transfer: Transfer): string[] {
  return [
    formatSourceAmount(
      transfer.totalChargeSource ?? transfer.totalChargeUsd,
      transfer.sourceCurrency ?? 'USD',
    ),
    transfer.recipientName,
    transfer.id,
  ];
}

/**
 * §3.3 scheduled_payment_ready — recurring-transfer approval with pay link.
 * Body: "Hi {{1}}, your scheduled transfer of {{2}} to {{3}} is ready for approval..."
 * Button URL suffix {{1}} = the pay token (the freshly created transfer's id).
 * Params: body [sender name, amount, recipient], button token = transferId.
 */
export function scheduledPaymentReadyParams(
  schedule: Schedule,
  transferId: string,
  senderName: string,
): TemplateWithButton {
  return {
    bodyParams: [
      senderName,
      formatSourceAmount(schedule.amountSource ?? schedule.amountUsd, schedule.sourceCurrency ?? 'USD'),
      schedule.recipientName,
    ],
    buttonToken: transferId,
  };
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
      transfer.recipientName,
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
    transfer.recipientName,
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

export function verificationStatusParams(name: string, state: VerificationState): string[] {
  const msg: Record<VerificationState, string> = {
    needed: 'Please verify your identity to start sending money.',
    in_progress: 'Your identity verification is in progress.',
    received: 'Thanks — we received your verification and are reviewing it. We’ll message you shortly.',
    verified: 'You’re verified! You can now send money.',
    failed: 'We couldn’t verify your identity. Please tap below to try again.',
  };
  return [name || 'there', msg[state]];
}

/**
 * Phase 3: the per-transaction step-up OTP message. Delivered IN-SESSION as
 * free-form text (the customer is actively paying → inside the 24-h window), so
 * it needs no AUTHENTICATION template. Pure (testable); the code is interpolated
 * by the caller and must never be logged.
 */
export function transactionOtpMessage(code: string): string {
  return `Your SmartRemit confirmation code is ${code}. Enter it on the payment page to send this transfer. It expires in 10 minutes.`;
}

/**
 * Account verification OTP (register / login step-up / password reset). The
 * approved Meta AUTHENTICATION template is preferred, but until it's live this
 * free-form text is the in-session fallback so a customer still receives the
 * code. Pure (testable); the code is interpolated by the caller and must never
 * be logged.
 */
export function otpMessage(code: string): string {
  return `Your SmartRemit verification code is ${code}. It expires in 10 minutes. Don't share it with anyone.`;
}
