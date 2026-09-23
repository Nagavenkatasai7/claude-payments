import type { Customer } from './types';
import { hasWebAddress, isCleanName, NAME_MAX } from './untrusted-text';

// Sender identity is required before screening (Program-Fix 14). Sanctions
// screening covers BOTH parties, so a consumer send needs the sender's legal
// name on file before any approval card, draft or mint. The B2B paths already
// refuse a nameless payer (b2b-pay-finalize: buyer_unscreened).

/** The one question the bot asks a sender with no legal name on file. */
export const SENDER_NAME_QUESTION = "What's your full legal name, as on your ID?";

/** Whether the customer has a usable legal name on file (whitespace ⇒ none). */
export function hasSenderName(customer: Pick<Customer, 'fullName'> | null | undefined): boolean {
  return (customer?.fullName ?? '').trim() !== '';
}

/**
 * Normalise a customer-typed legal name: NFKC, whitespace collapsed, trimmed.
 * null ⇒ not a plausible name (empty, one character, no letter, longer than
 * NAME_MAX, a control / format / markup character, or a web address).
 */
export function normalizeSenderName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = v.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (n.length < 2 || !/\p{L}/u.test(n)) return null;
  if (!isCleanName(n, NAME_MAX) || hasWebAddress(n) || /[<>]/.test(n)) return null;
  return n;
}

/** The pay page's answer when the sender's legal name is not on file yet. */
export const SENDER_NAME_REQUIRED_MESSAGE =
  "We need your full legal name before this transfer can go ahead. Please reply in the chat with your full name as on your ID, then open this link again.";
