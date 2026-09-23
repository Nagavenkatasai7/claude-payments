import { blindIndex } from '@/lib/blind-index';

// wa-message-ref — a KEYED reference to a WhatsApp message id (Program-Fix 26).
// Audit rows and log lines for delivery statuses carry this instead of the raw
// id: the blind-index HMAC (src/lib/blind-index.ts) under its own purpose, so
// a DB dump or a log drain cannot recover or match the id without the key.
//
// Rendered letters-only (hex digits 0-9 mapped to g-p) so the reference never
// holds a digit run: scrub() in log.ts masks any 7+ digit run, and a hex hash
// would otherwise be mangled differently in the log line than in the audit
// row, breaking the join between the two.

export const WA_MESSAGE_REF_PURPOSE = 'wa-msg';

const DIGIT_TO_LETTER = 'ghijklmnop';

/** Keyed, deterministic, letters-only reference to `messageId`. Never throws. */
export function waMessageRef(
  messageId: string,
  index: (purpose: string, value: string) => string = blindIndex,
): string {
  if (!messageId) return 'none';
  try {
    return index(WA_MESSAGE_REF_PURPOSE, messageId).replace(/[0-9]/g, (d) => DIGIT_TO_LETTER[Number(d)]);
  } catch {
    // Key missing or malformed: never fall back to the raw id.
    return 'unavailable';
  }
}
