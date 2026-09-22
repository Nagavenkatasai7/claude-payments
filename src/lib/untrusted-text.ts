// untrusted-text — the ONE sanitizer for text an outsider wrote that later
// reaches the agent (fix 5 / F43, F63): recipient and sender names from the
// external API, a business's brand text and bot persona, a seller's business
// name and bill line items.
//
// Two sides:
//  • WRITE — isCleanName refuses a dirty value at the edge (the caller returns
//    400 / a friendly re-ask), so nothing new is stored with it.
//  • READ — boundUntrustedText clamps anything ALREADY stored (pre-fix rows,
//    brand text that is stripped rather than refused) right before the model or
//    a system prompt sees it.
//
// "Dirty" means anything that can break out of a data field into the prompt's
// structure: control characters (\p{Cc}: newline, tab, NUL, BEL, DEL, C1),
// the Unicode line / paragraph separators, and the bracket characters []{}<>
// used by the agent's own "[NOTE]" markers and by markup. Pure; no I/O.

/** Recipient / sender / business names. */
export const NAME_MAX = 80;
/** A bill line-item description. */
export const BILL_TEXT_MAX = 120;
/** brandName / displayName. */
export const BRAND_MAX = 60;
/** botPersona. */
export const PERSONA_MAX = 500;
/** Short ids and phone numbers echoed back in structured context. */
export const ID_MAX = 32;

// Non-global twins for .test() (a /g regex carries lastIndex between calls).
const BREAKING = /[\p{Cc}\u2028\u2029]/u;
const BREAKING_ALL = /[\p{Cc}\u2028\u2029]/gu;
const MARKERS = /[[\]{}<>]/;
const MARKERS_ALL = /[[\]{}<>]/g;

/** Length in characters (code points), so a surrogate pair counts once. */
function charLength(v: string): number {
  return [...v].length;
}

/**
 * The read-side clamp. Control characters and line / paragraph separators
 * become a space, []{}<> are removed, whitespace runs collapse to one space,
 * and the result is trimmed and capped at `max` characters — the trailing '…'
 * included, never splitting a surrogate pair. A non-string (or a value that
 * strips to nothing) returns ''. A clean value comes back byte-for-byte.
 */
export function boundUntrustedText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const flat = v
    .replace(BREAKING_ALL, ' ')
    .replace(MARKERS_ALL, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  if (max <= 1) return max === 1 ? '…' : '';
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * The write-side gate: a non-blank string of at most `max` characters with no
 * control character, no line / paragraph separator and none of [ ] { } < >.
 * Letters in any script and ordinary punctuation (' - . & ( ) ,) pass.
 */
export function isCleanName(v: unknown, max: number = NAME_MAX): boolean {
  if (typeof v !== 'string' || v.trim() === '') return false;
  if (charLength(v) > max) return false;
  return !BREAKING.test(v) && !MARKERS.test(v);
}

/**
 * Shape check for an opaque value that is never shown raw (an inline payout
 * destination): at most `max` characters and no control character or line /
 * paragraph separator. Spaces, '|' and '@' stay legal — composed destinations
 * use them.
 */
export function isBoundedPrintable(v: unknown, max: number): boolean {
  return typeof v === 'string' && charLength(v) <= max && !BREAKING.test(v);
}
