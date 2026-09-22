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
// structure, or hide text from a human reviewer while the model still reads it:
//  • control characters (\p{Cc}: newline, tab, NUL, BEL, DEL, C1) and the
//    Unicode line / paragraph separators;
//  • invisible format characters (\p{Cf}: zero-width space / joiners, bidi
//    embeddings / overrides / isolates, word joiner, BOM, soft hyphen, and the
//    TAG block used for "ASCII smuggling");
//  • the bracket characters []{}<> used by the agent's own "[NOTE]" markers
//    and by markup — including lookalikes: every check runs on the NFKC form,
//    which folds the fullwidth / small forms to ASCII, and the CJK brackets
//    U+3008–3011 are markers too;
//  • lone surrogates (ill-formed UTF-16).
// NFKC leaves ordinary text in the supported scripts (Devanagari, Chinese,
// accented Latin, Arabic) readable. Pure; no I/O.

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
const FORMAT = /\p{Cf}/u;
const FORMAT_ALL = /\p{Cf}/gu;
const MARKERS = /[[\]{}<>\u3008-\u3011]/u;
const MARKERS_ALL = /[[\]{}<>\u3008-\u3011]/gu;
// In /u mode a PAIRED surrogate is one astral code point, so this class
// matches only LONE surrogates — the same test as ES2024
// String.prototype.isWellFormed, which tsconfig's ES2022 lib does not type.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const LONE_SURROGATE_ALL = /[\uD800-\uDFFF]/gu;

/** Length in characters (code points), so a surrogate pair counts once. */
function charLength(v: string): number {
  return [...v].length;
}

/** ES2024 String.prototype.toWellFormed: each lone surrogate becomes U+FFFD. */
function toWellFormed(v: string): string {
  return v.replace(LONE_SURROGATE_ALL, '\uFFFD');
}

/**
 * The read-side clamp. Lone surrogates become U+FFFD and the value is
 * NFKC-normalized; format characters are deleted; control characters and line
 * / paragraph separators become a space; brackets (ASCII and CJK) are removed;
 * whitespace runs collapse to one space; and the result is trimmed and capped
 * at `max` characters — the trailing '…' included, never splitting a surrogate
 * pair. A non-string (or a value that strips to nothing) returns ''. A clean,
 * NFC-composed value comes back byte-for-byte.
 */
export function boundUntrustedText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const flat = toWellFormed(v)
    .normalize('NFKC')
    .replace(FORMAT_ALL, '')
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
 * The write-side gate: a well-formed, non-blank string whose NFKC form has at
 * most `max` characters and no control character, line / paragraph separator,
 * format character, or bracket ([ ] { } < > and the CJK brackets U+3008–3011,
 * fullwidth forms included via NFKC). Letters in any script, combining marks
 * and ordinary punctuation (' - . & ( ) ,) pass. A name that needs a zero-width
 * joiner is refused (the joiner is invisible text); the read-side clamp would
 * delete it anyway.
 */
export function isCleanName(v: unknown, max: number = NAME_MAX): boolean {
  if (typeof v !== 'string' || LONE_SURROGATE.test(v)) return false;
  const n = v.normalize('NFKC');
  if (n.trim() === '' || charLength(n) > max) return false;
  return !BREAKING.test(n) && !FORMAT.test(n) && !MARKERS.test(n);
}

/**
 * Shape check for an opaque value that is never shown raw (an inline payout
 * destination): well-formed, at most `max` characters, and no control
 * character, line / paragraph separator or format character. Spaces, '|' and
 * '@' stay legal — composed destinations use them.
 */
export function isBoundedPrintable(v: unknown, max: number): boolean {
  return (
    typeof v === 'string' &&
    !LONE_SURROGATE.test(v) &&
    charLength(v) <= max &&
    !BREAKING.test(v) &&
    !FORMAT.test(v)
  );
}
