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
