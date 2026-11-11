// log — the PII-scrubbing structured logger for money paths (Stage 3).
//
// Policy: error/warn lines from payment, webhook, and messaging code MUST NOT
// carry full phone numbers, account numbers, or emails — an upstream log drain
// (Vercel logs, a future aggregator) is outside our encryption boundary.
// Codes/OTPs/tokens are never logged AT ALL (existing policy); this scrubber is
// the backstop for values that ride inside error messages we don't control
// (e.g. a provider echoing the request back in its error body).

import { redactSensitive } from './inbound-redact';
import { driverErrorText, isDriverError, isQueryError, queryErrorText, stripQueryParams } from './db-error';

// fix pack 5 (D8, P18): the travel-rule originator values (the sender's
// address and date of birth). A backstop, the code never logs them (static
// guard tests/originator-no-log.test.ts): a non-null value under one of these
// keys is written '<redacted>' in an object, in JSON text and as a top-level
// log field. The text rule reads a JSON string value whole, escapes included,
// and also a value the 8 KB cap cut before its closing quote. It runs on the
// capped text (bounded work, Program-Fix 47) before every other rule.
const ORIGINATOR_KEYS: ReadonlySet<string> = new Set([
  'address', 'date_of_birth', 'senderAddress', 'senderDob', 'residentialAddress', 'dateOfBirth',
]);
const ORIGINATOR_JSON =
  /"(address|date_of_birth|senderAddress|senderDob|residentialAddress|dateOfBirth)"\s*:\s*"(?:[^"\\]|\\.)*(?:"|$)/g;

/**
 * JSON.stringify replacer: an originator value becomes '<redacted>'; a query
 * or driver error inside an object becomes its fixed description.
 */
function nestedQueryErrors(key: string, v: unknown): unknown {
  if (ORIGINATOR_KEYS.has(key) && v !== null && v !== undefined) return '<redacted>';
  return isQueryError(v) ? queryErrorText(v) : isDriverError(v) ? driverErrorText(v) : v;
}

/**
 * The first stack frames of an error (`    at fn (file:line)`), never the stack
 * header: the header repeats the message, and a message can hold customer data.
 * When the header cannot be found (the message changed after the stack was
 * taken) nothing is returned, because a message line can itself look like a frame.
 */
export function stackFrames(err: unknown, max = 3): string {
  try {
    if (!(err instanceof Error) || typeof err.stack !== 'string') return '';
    const header = `${err.name}: ${err.message}`;
    if (!err.stack.startsWith(header)) return '';
    return err.stack
      .slice(header.length)
      .split('\n')
      .filter((l) => /^\s+at /.test(l))
      .slice(0, max)
      .map((l) => l.trim())
      .join(' | ');
  } catch {
    return '';
  }
}

/**
 * Mask emails and any 7+ digit run (phones, accounts, IBAN/PAN bodies) to
 * last-4. The threshold is 7 — not 6 — so 6-digit provider ERROR CODES (e.g.
 * Meta's 131056) stay readable for ops. OTPs are also 6 digits, but codes are
 * never logged at all by policy; this scrubber is the backstop for PII riding
 * inside messages we don't control.
 *
 * R49: the inbound-redact patterns run first (redactSensitive), so the numbers
 * the 7-digit mask cannot see whole (spaced card groups, a 3-2-4 SSN, PAN,
 * IFSC, a 4-4-4 Aadhaar, a spaced IBAN, a short account number after its
 * keyword) become their fixed label. The labels hold no digits.
 */
export function scrub(value: unknown): string {
  // 2026-11-10: a database query error never reaches the rules below whole. Its
  // message and `params` carry the bound values and its cause the Postgres
  // `detail` (src/lib/db-error.ts); the object becomes the fixed description,
  // and the params tail of any "Failed query:" text is cut.
  const s =
    typeof value === 'string'
      ? stripQueryParams(value)
      : isQueryError(value)
        ? queryErrorText(value)
        : isDriverError(value)
          ? driverErrorText(value)
          : value instanceof Error
          ? stripQueryParams(`${value.name}: ${value.message}`)
          : stripQueryParams(JSON.stringify(value, nestedQueryErrors) ?? String(value));
  const capped = capInput(s);
  const unoriginated = capped.text.replace(ORIGINATOR_JSON, '"$1":"<redacted>"');
  // The URL-credentials rule runs FIRST (2026-11-09 DATABASE_URL leak), on the
  // raw text: a later mask must not break a password into parts it cannot see.
  const text = capped.cut ? unoriginated.replace(URL_CUT_TAIL, '$1<redacted>') : unoriginated;
  const out = redactSensitive(text.replace(URL_USERINFO, '$1<redacted>@'))
    .text.replace(EMAIL, '<email>')
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

// The credentials part of a URL (`scheme://user:password@host`). It runs BEFORE
// the email mask: on its own that mask caught only the tail of the userinfo and
// left most of a password that holds URL sub-delimiters (2026-11-09 review of
// the DATABASE_URL leak). Greedy up to the LAST "@" of the authority, so a
// password with an unescaped "@" goes whole. The run stops at whitespace and at
// the characters that end an authority or cannot be in one (/ ? # " < >), so an
// "@" in a query string or in the next JSON field is not taken for userinfo.
// The lookbehind starts a match only at the start of a scheme token, which
// keeps the work linear under the 8 KB cap, like EMAIL above.
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"<>]*@/g;

// When the 8 KB cap cuts a URL inside its authority, the "@" that URL_USERINFO
// needs is gone and the start of a password would stay. Whatever follows the
// scheme at the very end of a cut text goes (a host cut in half is no loss).
const URL_CUT_TAIL = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#"<>]*$/;

/** Longest input scrub() looks at; the rest is dropped with a visible marker. */
export const SCRUB_MAX_CHARS = 8 * 1024;
const TRUNCATED = '…[truncated]';

/**
 * Cut `s` to SCRUB_MAX_CHARS, then back to the last character that cannot be
 * part of a phone number or an email. A cut through `15551234567` could leave
 * up to 6 digits (below the 7-digit mask), and a cut through `name@example.com`
 * leaves `name@exam`, which no longer looks like an email; both are dropped
 * whole instead. R49: a trailing run of digit groups (`4111 1111 11`, a card
 * cut mid-way, which no rule would recognise) is dropped too.
 */
function capInput(s: string): { text: string; cut: boolean } {
  if (s.length <= SCRUB_MAX_CHARS) return { text: s, cut: false };
  let end = SCRUB_MAX_CHARS;
  while (end > 0 && /[A-Za-z0-9._%+@-]/.test(s[end - 1])) end--;
  // Linear, from the end: drop the trailing digits, spaces and hyphens when they hold a digit.
  let tail = end;
  while (tail > 0 && /[\d \-]/.test(s[tail - 1])) tail--;
  if (/\d/.test(s.slice(tail, end))) end = tail;
  return { text: s.slice(0, end), cut: true };
}

function emit(level: 'error' | 'warn', scope: string, message: unknown, fields?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    level,
    scope,
    msg: scrub(message),
    at: new Date().toISOString(),
  };
  // fix pack 5 (D8, P18): a top-level field is scrubbed by value, so its key is
  // checked here (an originator value never reaches the line).
  for (const [k, v] of Object.entries(fields ?? {})) {
    line[k] = ORIGINATOR_KEYS.has(k) && v != null ? '<redacted>' : scrub(v);
  }
  // One JSON line per event — greppable in Vercel logs, parseable by a drain.
  (level === 'error' ? console.error : console.warn)(JSON.stringify(line));
}

export function logError(scope: string, message: unknown, fields?: Record<string, unknown>): void {
  emit('error', scope, message, fields);
}

export function logWarn(scope: string, message: unknown, fields?: Record<string, unknown>): void {
  emit('warn', scope, message, fields);
}
