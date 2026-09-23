// log — the PII-scrubbing structured logger for money paths (Stage 3).
//
// Policy: error/warn lines from payment, webhook, and messaging code MUST NOT
// carry full phone numbers, account numbers, or emails — an upstream log drain
// (Vercel logs, a future aggregator) is outside our encryption boundary.
// Codes/OTPs/tokens are never logged AT ALL (existing policy); this scrubber is
// the backstop for values that ride inside error messages we don't control
// (e.g. a provider echoing the request back in its error body).

/**
 * Mask emails and any 7+ digit run (phones, accounts, IBAN/PAN bodies) to
 * last-4. The threshold is 7 — not 6 — so 6-digit provider ERROR CODES (e.g.
 * Meta's 131056) stay readable for ops. OTPs are also 6 digits, but codes are
 * never logged at all by policy; this scrubber is the backstop for PII riding
 * inside messages we don't control.
 */
export function scrub(value: unknown): string {
  const s =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? `${value.name}: ${value.message}`
        : JSON.stringify(value) ?? String(value);
  const capped = capInput(s);
  const out = capped.text
    .replace(EMAIL, '<email>')
    .replace(/\d{7,}/g, (m) => `…${m.slice(-4)}`);
  return capped.cut ? `${out}${TRUNCATED}` : out;
}

// Program-Fix 47 — bounded work on input we do not control. A domain label
// cannot contain the dot that ends it, so the domain part never overlaps, and
// the lookbehind lets a match start only at the start of a token (not at every
// position inside a long run). With the 8 KB cap below, that bounds the work.
// Parts are deliberately NOT length-bounded: an over-long local part or label
// is still PII and must be masked whole.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;

/** Longest input scrub() looks at; the rest is dropped with a visible marker. */
export const SCRUB_MAX_CHARS = 8 * 1024;
const TRUNCATED = '…[truncated]';

/**
 * Cut `s` to SCRUB_MAX_CHARS, then back to the last character that cannot be
 * part of a phone number or an email. A cut through `15551234567` could leave
 * up to 6 digits (below the 7-digit mask), and a cut through `name@example.com`
 * leaves `name@exam`, which no longer looks like an email; both are dropped
 * whole instead.
 */
function capInput(s: string): { text: string; cut: boolean } {
  if (s.length <= SCRUB_MAX_CHARS) return { text: s, cut: false };
  let end = SCRUB_MAX_CHARS;
  while (end > 0 && /[A-Za-z0-9._%+@-]/.test(s[end - 1])) end--;
  return { text: s.slice(0, end), cut: true };
}

function emit(level: 'error' | 'warn', scope: string, message: unknown, fields?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    level,
    scope,
    msg: scrub(message),
    at: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(fields ?? {})) line[k] = scrub(v);
  // One JSON line per event — greppable in Vercel logs, parseable by a drain.
  (level === 'error' ? console.error : console.warn)(JSON.stringify(line));
}

export function logError(scope: string, message: unknown, fields?: Record<string, unknown>): void {
  emit('error', scope, message, fields);
}

export function logWarn(scope: string, message: unknown, fields?: Record<string, unknown>): void {
  emit('warn', scope, message, fields);
}
