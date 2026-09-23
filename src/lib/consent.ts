import { DEFAULT_BRAND } from './partner-config';

// WhatsApp consent (opt-in / opt-out) keyword detection.
//
// Match rule: case-insensitive, trimmed, WHOLE-message exact match only — never
// a substring. This is deliberate: bare "stop" opts the user out, but
// "stop the transfer" or "cancel" must NOT (those route to the agent / draft
// cancel). Honoring an opt-out is a WhatsApp compliance requirement, so the
// keyword sets are intentionally small and closed.

const OPT_OUT_KEYWORDS = new Set(['stop', 'unsubscribe']);
const OPT_IN_KEYWORDS = new Set(['start', 'unstop']);

export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_KEYWORDS.has(text.trim().toLowerCase());
}

export function isResumeKeyword(text: string): boolean {
  return OPT_IN_KEYWORDS.has(text.trim().toLowerCase());
}

export const OPT_OUT_REPLY =
  "You've been unsubscribed. Reply START to resume.";
export const OPT_IN_REPLY =
  "You're resubscribed. Welcome back! How can I help you send money today?";

// Sent when an ALREADY opted-out customer sends a normal (non-keyword) message,
// taps a button, or sends media. Distinct from OPT_OUT_REPLY, which confirms a
// *fresh* STOP. This one is the brief reminder for the opted-out STATE: it
// nudges resume without re-running the send flow (the agent is skipped
// entirely for opted-out senders). Program-Fix 49A: it names the TENANT's
// brand (a BYO-number partner's customers never see "SmartRemit"); the inbound
// pipeline rate-limits it to one per (tenant, phone) per hour.
export function optOutReminder(brand?: string): string {
  return `You're unsubscribed from ${brand?.trim() || DEFAULT_BRAND}. Reply START to resume.`;
}
export const OPT_OUT_REMINDER = optOutReminder(DEFAULT_BRAND);

// Program-Fix 49A (whatsapp-08): the reply to an image, voice note, document,
// sticker, location or contact card. The bot never downloads media; this is an
// honest one-line answer instead of silence, and it steers the customer away
// from sending identity documents or bank details in chat.
export const MEDIA_REPLY =
  'I can only read typed messages here. Please type your question. Never send ID photos or bank details in chat.';
