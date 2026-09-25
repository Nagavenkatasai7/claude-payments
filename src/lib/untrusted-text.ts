import { domainToASCII } from 'node:url';
import { IANA_TLDS } from './iana-tlds';

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

// ── Program-Fix 38: web addresses and rule-override phrases ─────────────────
// WhatsApp turns a web address in a system-sent message into a tappable link,
// and the bot is barred from typing links — so outsider-written text (a seller's
// business name, an API-supplied recipient name, a business's bot persona) must
// not carry one. The detector is a heuristic: a scheme ("://"), "www.", a
// dotted IPv4 address, or a host label followed by a common TLD. Every check
// runs on the boundUntrustedText form, so fullwidth dots, bracketed dots
// ("evil[.]com") and zero-width splits collapse into detectable text first.

/**
 * The brief's common TLDs, plus the reserved `example` (the audit's fixtures)
 * and a few more that are not ordinary English words — a word TLD (pay, shop,
 * live, to, ...) would refuse "Design work.Pay within 7 days", a common typo.
 */
const WEB_TLDS = [
  'com', 'net', 'org', 'io', 'ai', 'app', 'co', 'me', 'ly', 'link', 'xyz', 'info', 'in', 'uk', 'us',
  'example', 'dev', 'biz', 'gg', 'ru', 'cn', 'tk', 'ca', 'au', 'nz', 'sg', 'ae', 'hk', 'mx', 'de',
  'fr', 'eu', 'tv', 'cc', 'gov', 'edu',
  // cheap TLDs common in abuse, none of them an English word
  'icu', 'pw', 'cfd', 'sbs', 'cyou',
];
/**
 * Short words that often come before a dot and a slash in ordinary bill text
 * ("Hrs.approx/week", "Mon.Fri/Sat"). The host+path rule never treats them as
 * a host. Host labels under 3 characters ("sq.ft/month", "Mr.Rahul/Priya")
 * are skipped too.
 */
const PATH_RULE_ABBREVIATIONS = [
  'hrs', 'min', 'mins', 'sec', 'secs', 'day', 'days', 'wk', 'wks', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs',
  'fri', 'sat', 'sun', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'approx', 'qty', 'pcs', 'nos', 'max', 'est', 'ref', 'inv', 'per', 'mrs', 'kgs', 'lbs', 'sqft', 'unit', 'units',
];
/** The detector reads at most this many characters (a cap on the regex work). */
const DETECT_MAX = 4096;
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const WEB_ADDRESS = new RegExp(
  [
    '://',
    '(?<![\\p{L}\\p{N}])www\\.',
    '(?<![\\p{L}\\p{N}.])\\d{1,3}(?:\\.\\d{1,3}){3}(?![\\p{L}\\p{N}])',
    // host with a path: "evil.whatever/x". The match starts at the start of
    // the dotted chain. Its first label has 3+ characters and is not a common
    // abbreviation, and its last label is letters (or an IDN "xn--" label),
    // so "3.5/hr", "no.12/2026", "sq.ft/month" and "Mon.Fri/Sat" are not hosts.
    `(?<![\\p{L}\\p{N}.-])(?!(?:${PATH_RULE_ABBREVIATIONS.join('|')})\\.)[\\p{L}\\p{N}][\\p{L}\\p{N}-]*[\\p{L}\\p{N}](?<=[\\p{L}\\p{N}-]{3})(?:\\.${LABEL})*\\.(?:\\p{L}{2,}|xn--[\\p{L}\\p{N}-]+)/`,
    // host ending in a known TLD: "acme.com", "pay.evil.example"
    `(?<![\\p{L}\\p{N}-])${LABEL}\\.(?:${WEB_TLDS.join('|')})(?![\\p{L}\\p{N}-])`,
    // host ending in an IDN (punycode) label: "pay.xn--p1ai"
    `(?<![\\p{L}\\p{N}-])${LABEL}\\.xn--[\\p{L}\\p{N}-]+`,
  ].join('|'),
  'iu',
);
// The ideographic / halfwidth full stops are not folded by NFKC; treat them as dots.
const IDEOGRAPHIC_DOTS = /[。｡]/gu;

function detectForm(v: unknown): string {
  return boundUntrustedText(v, DETECT_MAX).replace(IDEOGRAPHIC_DOTS, '.').toLowerCase();
}

/** Whether a value carries a web address (heuristic; see the note above). Pure. */
export function hasWebAddress(v: unknown): boolean {
  const s = detectForm(v);
  return s !== '' && WEB_ADDRESS.test(s);
}

// "ignore / disregard / override / forget" followed, within three words, by
// "previous / prior / above / earlier / rules / instructions / limits /
// guidelines". Bounded quantifiers only (no backtracking blow-up).
const OVERRIDE_PHRASE =
  /\b(?:ignore|disregard|override|forget)\b(?:\s+\S+){0,3}?\s+(?:previous|prior|above|earlier|rules?|instructions?|limits?|guidelines?)\b/iu;

/**
 * Whether a value contains a rule-override phrase — the closed set above.
 * Used to refuse a bot persona at save. Pure.
 */
export function hasOverridePhrase(v: unknown): boolean {
  const s = detectForm(v);
  return s !== '' && OVERRIDE_PHRASE.test(s);
}

// ── R6b: model-output host stripping (final structural round) ────────────────
// Used ONLY on text the model wrote (sanitizeReply). hasWebAddress, used on
// outsider text, is deliberately unchanged and is only an extra trigger here.
//
// 1. Tokens split on VISIBLE whitespace only (U+FEFF is not a separator).
// 2. A token containing a dot or any character whose NFKC form contains a dot
//    ("dotted token") is SENT in canonical form: default-ignorable, control and
//    format characters are deleted and the single-dot lookalikes are folded to
//    ".". Tokens without a dot are sent untouched, so emoji keep their variation
//    selectors and joiners (a dotted token like "❤\ufe0f." loses its U+FE0F).
// 3. One detector: a token is a host when hasWebAddress(token), or when any
//    dotted span of its NFKC, lower-cased, de-bracketed form ("[.]", "(.)",
//    "{.}" are dots) has a label after its first that is a real IANA TLD, read
//    from the node:url domainToASCII (UTS46) form and, fail-closed, also from
//    the span as written. A label's head before a "-" counts too (punycode
//    keeps its "xn--"), and a leading-dot span counts (".net").
// 4. The only exception: the RAW token, lower-cased, stripped of wrapping
//    brackets, quotes, *_~` marks and trailing punctuation, with one optional
//    "www.", equals an allowed bare host. Anything else in it strips it.

/** Every code point whose NFKC form contains "." (checked by a test over all of Unicode). */
const DOT_LIKE = /[.。｡․-…⒈-⒛㏂㏇㏘︙︰﹒．\u{1f100}]/u;
/** Single-dot lookalikes folded to "." in the SENT text of a dotted token. */
const SENT_DOT_FOLD = /[。｡．․﹒]/gu;
const INVISIBLE_ALL = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu;
const DEFANGED_DOT = /[[({]\.[\])}]/gu;
const MODEL_SPAN = /[\p{L}\p{M}\p{N}\p{So}-]*(?:\.[\p{L}\p{M}\p{N}\p{So}-]+)+/gu;
const TLDS: ReadonlySet<string> = new Set(IANA_TLDS.map((t) => t.normalize('NFKC').toLowerCase()));

function labelIsTld(label: string): boolean {
  if (TLDS.has(label)) return true;
  // The label's head before a "-" ("online-x" → "online"); for a punycode
  // label the "xn--" prefix stays on ("xn--p1ai-x" → "xn--p1ai").
  const head = label.startsWith('xn--') ? `xn--${label.slice(4).split('-')[0]}` : label.split('-')[0];
  return head !== '' && head !== 'xn--' && TLDS.has(head);
}

/**
 * The form a model-written token is SENT in (see note 2): unchanged unless it
 * is a dotted token. Pure.
 */
export function canonicalModelToken(token: string): string {
  if (!DOT_LIKE.test(token)) return token;
  return toWellFormed(token).replace(INVISIBLE_ALL, '').replace(SENT_DOT_FOLD, '.');
}

/**
 * Whether one model-written TOKEN names a host on a real TLD (see note 3).
 * Broader than hasWebAddress on purpose; use it only on model output. Pure.
 */
export function hasModelHost(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const d = toWellFormed(v).replace(INVISIBLE_ALL, '').normalize('NFKC').replace(SENT_DOT_FOLD, '.').toLowerCase().replace(DEFANGED_DOT, '.');
  for (const m of d.matchAll(MODEL_SPAN)) {
    const ascii = domainToASCII(m[0]);
    for (const form of ascii ? [ascii, m[0]] : [m[0]]) {
      if (form.split('.').slice(1).some(labelIsTld)) return true;
    }
  }
  return false;
}

/** Wrapping characters trimmed before the exact allow-list match. */
const EDGE_START = /^[(<[{"'“‘*_~`]+/u;
const EDGE_END = /[.,!?;:'"”’…)\]}>*_~`]+$/u;

/**
 * A token is a run of anything but VISIBLE whitespace. Unlike \s, this leaves
 * out U+FEFF (an invisible zero-width no-break space), so it cannot split a
 * host into two harmless-looking tokens.
 */
const MODEL_TOKEN = /[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

/**
 * R6b (A7L-2): the model-output host strip (see the note above). Every token
 * that names a host is removed unless it is exactly an allowed bare host;
 * every other dotted token is sent in canonical form; whitespace, newlines
 * included, is kept. Code-made links are appended after this and never pass
 * through it. Pure.
 */
export function stripModelHosts(text: string, allowHosts: readonly string[]): string {
  const allow = new Set(allowHosts.map((h) => h.toLowerCase().replace(/^www\./u, '')).filter((h) => h !== ''));
  return text.replace(MODEL_TOKEN, (token) => {
    if (!hasWebAddress(token) && !hasModelHost(token)) return canonicalModelToken(token);
    // The RAW token, not a folded form: any invisible or bracket character in
    // an allowed host makes it not match, so it strips.
    const core = token.toLowerCase().replace(EDGE_START, '').replace(EDGE_END, '').replace(/^www\./u, '');
    return allow.has(core) ? token : '';
  });
}

function stripWebAddressTokens(s: string): string {
  return s
    .split(' ')
    .filter((token) => token !== '' && !hasWebAddress(token))
    .join(' ')
    .trim();
}

/**
 * The render-time clamp for outsider text inside a SYSTEM-SENT message (a
 * buyer push, a recipient template param, a sender confirmation):
 * boundUntrustedText, with every whitespace-separated token that carries a web
 * address removed, capped at `max`. Runs the strip again after the cap, so a
 * truncation can never leave a linkifiable tail. A value that strips to
 * nothing returns '' — the caller falls back to its own default text.
 */
export function safeDisplayText(v: unknown, max: number): string {
  const wide = boundUntrustedText(v, Math.max(max, 1) * 4);
  const capped = boundUntrustedText(stripWebAddressTokens(wide), max);
  return stripWebAddressTokens(capped);
}
