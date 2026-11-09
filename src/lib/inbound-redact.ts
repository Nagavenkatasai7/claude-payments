import type { NoticeLang } from './ai-notice';

/**
 * inbound-redact (R49 part 1) — hide the card, bank account, routing, IFSC,
 * SSN/ITIN, PAN, Aadhaar and IBAN numbers a customer types into chat BEFORE the
 * text reaches the model, the Redis history, the outbox payload, the permanent
 * conversation log or a log line. Every inbound surface calls it: WhatsApp and
 * Telegram (whatsapp-inbound.ts processMessage), a voice note's transcript
 * (outbox-worker.ts) and web chat (web-chat.ts); log.ts scrub() runs it too.
 *
 * What stays untouched, on purpose: phone numbers (a recipient's WhatsApp
 * number is how the add-recipient flow works), amounts, dates, codes, referral
 * codes and transfer ids. So every rule is a checksum, a strict format or a
 * keyword, never a bare length:
 *
 *  - card: 15 digits starting 34/37, or 16-19 digits with a card prefix, and
 *    Luhn-valid. Groups may be split by spaces of any width, a line break, or
 *    one '-', '.' or ',' (the first group then has 4 digits, or every group
 *    has one). A phone has at most 15 digits, and a 15-digit Amex shape after
 *    a '+' is never read as a card. Comma or dot groups in an amount context
 *    ("amounts 2000, 1500, …") are a list of amounts.
 *  - cvv: 3-4 digits right after a cvv/cvc/security code keyword.
 *  - routing: 9 digits, ABA checksum, in a message that says routing/ABA/ACH.
 *  - account: 6-18 digits right after an account / acct / a/c / khata / खाता /
 *    cuenta keyword; or 8-18 digits in a message that also has an IFSC or a
 *    routing number, unless it is shaped like a phone, follows a phone keyword
 *    (phone, whatsapp, mobile, …), is an 8-digit date or is written as an amount.
 *  - ifsc: four letters, a zero, six letters or digits (one letter case).
 *  - ssn: 3-2-4 formatted (spaces, '-' or '.'; not in an amount context such
 *    as "send 500 25 1000"), or 9 digits right after an ssn/itin keyword.
 *  - pan: five letters, four digits, a letter (one letter case). The entity
 *    letter is not checked, so the common sample ABCDE1234F is hidden too.
 *  - aadhaar: 12 digits starting 2-9, Verhoeff-valid, and either 4-4-4
 *    formatted (not in an amount context) or right after an aadhaar / aadhar /
 *    uid / आधार keyword.
 *  - iban: country letters, check digits and 11-30 letters or digits (one
 *    letter case, spaced in fours or not), mod-97 valid.
 *
 * A '+' before a number marks a phone: no rule reads its first group. Ids and
 * codes are protected by token boundaries: letters, digits, '_' and '-' join a
 * token, so a digit run inside a transfer id is never a candidate.
 *
 * Each match becomes a fixed English label such as [card number hidden]. The
 * labels hold no digits, so redacting twice changes nothing and the reply
 * guard and the log mask never read a label as a figure. The rules read a copy
 * with zero-width and other format characters dropped and every decimal digit
 * (fullwidth, Devanagari, …) as ASCII, mapped back to the input, so the text
 * around a hidden number stays byte for byte. Pure; never throws; every
 * keyword window and separator is bounded, so no pattern backtracks
 * exponentially (tests/inbound-redact.test.ts pins the timing).
 */

export type RedactedKind = 'card' | 'cvv' | 'routing' | 'account' | 'ifsc' | 'ssn' | 'pan' | 'aadhaar' | 'iban';

export const REDACTION_LABELS: Readonly<Record<RedactedKind, string>> = {
  card: '[card number hidden]',
  cvv: '[card code hidden]',
  routing: '[routing number hidden]',
  account: '[account number hidden]',
  ifsc: '[IFSC hidden]',
  ssn: '[SSN hidden]',
  pan: '[PAN hidden]',
  aadhaar: '[Aadhaar number hidden]',
  iban: '[IBAN hidden]',
};

/**
 * The one line the reply leads with when something was hidden (composeReply's
 * redaction slot). Draft wording, owner sign-off pending with the other PR1
 * safety texts. No digits; one line each.
 */
export const REDACTION_NOTICES: Readonly<Record<NoticeLang, string>> = {
  en: 'For your safety we hid the number you typed. Never send card, bank or ID numbers in chat: bank details go only on the secure payment page.',
  hinglish:
    'Aapki safety ke liye humne aapka bheja number chhupa diya hai. Card, bank ya ID number chat mein kabhi na bhejein: bank details sirf secure payment page par bharein.',
  es: 'Por tu seguridad ocultamos el número que escribiste. Nunca envíes números de tarjeta, cuenta o identidad por chat: los datos bancarios van solo en la página de pago segura.',
};

export function redactionNotice(lang: NoticeLang): string {
  return REDACTION_NOTICES[lang] ?? REDACTION_NOTICES.en;
}

export interface Redaction {
  text: string;
  /** Each kind hidden, once, in the order it first appears. Empty ⇒ the text is unchanged. */
  kinds: RedactedKind[];
}

// ── checksums ───────────────────────────────────────────────────────────────

export function luhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The ABA routing checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
export function abaValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 7, 6, 0, 8],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** The Verhoeff check (Aadhaar's last digit). */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const n = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][n]];
  }
  return c === 0;
}

/** ISO 13616 mod-97 on a compact IBAN (letters either case). */
export function ibanValid(compact: string): boolean {
  if (!/^[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}$/.test(compact)) return false;
  const s = (compact.slice(4) + compact.slice(0, 4)).toUpperCase();
  let rem = 0;
  for (const ch of s) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1;
}

// ── keywords ────────────────────────────────────────────────────────────────

// Words that may sit between a keyword and its number ("account number is",
// "khata number", "aadhaar card no."). Bounded: the keyword test looks at the
// last KW_WINDOW characters before a number only.
//
// The filler is unambiguous and bounded (review fix, ReDoS): each word must end
// at a non-letter, no word is a prefix of another that could split one run of
// letters two ways ("no" vs the old "n[oº°]"), and at most four words repeat.
// A "nonono…x" window therefore costs a constant number of steps, not 2^k.
const FILLER = String.raw`(?:[\s:#=.\-]*(?:numbers|number|numero|número|num|nr|n[º°]|no|is|was|hai|card|details|sankhya|नंबर|संख्या)(?!\p{L})){0,4}[\s:#=.\-]*$`;
const KW_WINDOW = 60;
// "acc" alone is a keyword when no/num/number/#/: follows it, or the number itself ("acc 50100123456789").
const ACCOUNT_KW = new RegExp(String.raw`(?<!\p{L})(?:account|acct|a\/c|acc(?=[\s.:#\-]*(?:no|num|number|#|:|$))|khata|खाता|cuenta)` + FILLER, 'iu');
const SSN_KW = new RegExp(String.raw`(?<!\p{L})(?:ssn|itin|social security|seguro social)` + FILLER, 'iu');
const AADHAAR_KW = new RegExp(String.raw`(?<!\p{L})(?:aadhaar|aadhar|adhaar|adhar|uidai|uid|आधार)` + FILLER, 'iu');
const CVV_KW = new RegExp(String.raw`(?<!\p{L})(?:cvv2?|cvc2?|cid|security code|card code)` + FILLER, 'iu');
const ROUTING_WORD = /(?<!\p{L})(?:routing|aba|rtn|ach)(?!\p{L})/iu;

// An amount: a currency right before the number, or a unit right after it.
const AMOUNT_BEFORE = /(?:[$₹€£¥]|(?<!\p{L})(?:rs\.?|inr|usd|aed|eur|gbp|mxn|cad|aud))\s*$/iu;
const AMOUNT_AFTER = /^\s*(?:rupees?|rs(?!\p{L})|inr|usd|dollars?|lakhs?|lacs?|crores?|k(?!\p{L})|aed|eur|gbp|mxn|pesos?)/iu;

// An amount list: an amount word or a currency just before the number. The
// unkeyed 4-4-4 Aadhaar, 3-2-4 SSN and comma- or dot-grouped card rules skip a
// number in this context ("amounts 2000 1500 3000", "send 500 25 1000").
const AMOUNT_CONTEXT_BEFORE =
  /(?:(?<!\p{L})(?:amounts?|send|sending|sent|pay|paying|paid|transfer|total|rs\.?|inr|usd|aed|eur|gbp|mxn|cad|aud|dollars?|rupees?|pesos?)|[$₹€£¥])[\s:#=\-]*$/iu;

// Phone shapes kept out of the message-level account rule: an Indian mobile
// (with or without 91 / 0), and a US number with its leading 1.
const PHONE_SHAPE = /^(?:[6-9]\d{9}|91[6-9]\d{9}|0[6-9]\d{9}|1[2-9]\d{9})$/;
// A phone keyword right before a number marks it a phone, whatever its shape
// ("recipient phone 415 555 2671", "her whatsapp 447911123456").
const PHONE_KW = new RegExp(
  String.raw`(?<!\p{L})(?:phone|ph|mobile|mob|cell|cellphone|whatsapp|wa|tel|telephone|contact|call|फोन|फ़ोन|मोबाइल|teléfono|telefono|celular|móvil|movil)` + FILLER,
  'iu',
);
// An 8-digit date (YYYYMMDD or DDMMYYYY) is never the message-level account number.
const DATE_SHAPE = /^(?:(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2})$/;

// ── candidates ──────────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number;
  kind: RedactedKind;
}

interface Group {
  start: number;
  end: number;
  digits: string;
  /** The characters between this group and the one before it ('' for the first). */
  sep: string;
}

interface DigitRun {
  start: number;
  end: number;
  groups: Group[];
  /** A '+' right before it: a phone with its country code. */
  plus: boolean;
}

// Digit groups joined by ONE space (any width) or hyphen. A run never starts
// or ends inside a token (letters, digits, '_', or a '-' joined to one), so ids
// stay whole. Every rule but the card and the 3-2-4 SSN reads these runs.
const RUN = /(?<![A-Za-z0-9_])(?<![A-Za-z0-9_]-)\d+(?:[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000-]\d+)*(?![A-Za-z0-9_])(?!-[A-Za-z0-9_])/g;
// The card and 3-2-4 SSN rules also read groups split by up to two spaces, a
// line break, or one '-', '.' or ',' with spaces around it ("4111, 1111, …",
// "4111\n1111\n…", "123.45.6789", "123 - 45 - 6789"). Each separator is bounded.
const HWS = String.raw`[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]`;
const PUNCT = String.raw`[\-.,\u2010-\u2015\u2212]`;
const BROAD_SEP = String.raw`(?:${HWS}{1,2}(?:${PUNCT}${HWS}{0,2})?|${PUNCT}${HWS}{0,2}|${HWS}{0,2}\r?\n${HWS}{0,2})`;
const BROAD_RUN = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?<![A-Za-z0-9_][\-.,])\d+(?:${BROAD_SEP}\d+)*(?![A-Za-z0-9_])(?!-[A-Za-z0-9_])`,
  'g',
);
const TOKEN_EDGE_BEFORE = String.raw`(?<![A-Za-z0-9_\-])`;
const TOKEN_EDGE_AFTER = String.raw`(?![A-Za-z0-9_\-])`;
const IFSC_RE = new RegExp(TOKEN_EDGE_BEFORE + String.raw`[A-Za-z]{4}0[A-Za-z0-9]{6}` + TOKEN_EDGE_AFTER, 'g');
const PAN_RE = new RegExp(TOKEN_EDGE_BEFORE + String.raw`[A-Za-z]{5}\d{4}[A-Za-z]` + TOKEN_EDGE_AFTER, 'g');
const IBAN_COMPACT_RE = new RegExp(TOKEN_EDGE_BEFORE + String.raw`[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}` + TOKEN_EDGE_AFTER, 'g');
const IBAN_SPACED_RE = new RegExp(TOKEN_EDGE_BEFORE + String.raw`[A-Za-z]{2}\d{2}(?: [A-Za-z0-9]{1,4}){3,8}`, 'g');

/** Letters all one case (an id mixes them; a typed code does not). */
function oneCase(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters === letters.toUpperCase() || letters === letters.toLowerCase();
}

function digitRuns(text: string, re: RegExp): DigitRun[] {
  const runs: DigitRun[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const groups: Group[] = [];
    let prevEnd = start;
    for (const g of m[0].matchAll(/\d+/g)) {
      const gs = start + (g.index ?? 0);
      groups.push({ start: gs, end: gs + g[0].length, digits: g[0], sep: text.slice(prevEnd, gs) });
      prevEnd = gs + g[0].length;
    }
    runs.push({ start, end: start + m[0].length, groups, plus: text[start - 1] === '+' });
  }
  return runs;
}

/** A separator holding a comma or a dot (a list of amounts can look like that). */
const LISTY_SEP = /[.,]/;

/** An amount word or currency just before `at`, or a unit just after `end`. */
function amountContext(text: string, at: number, end: number): boolean {
  return AMOUNT_CONTEXT_BEFORE.test(before(text, at)) || AMOUNT_AFTER.test(text.slice(end, end + 12));
}

const before = (text: string, at: number) => text.slice(Math.max(0, at - KW_WINDOW), at);

function cardPrefixOk(d: string): boolean {
  if (d.length === 15) return /^3[47]/.test(d);
  return d.length >= 16 && d.length <= 19 && /^(?:[2-6]|8[12])/.test(d);
}

/** Card windows: a run's consecutive groups, the longest valid one from each start. */
function cardSpans(text: string, run: DigitRun): Span[] {
  const out: Span[] = [];
  const g = run.groups;
  let i = run.plus ? 1 : 0;
  while (i < g.length) {
    let best = -1;
    let digits = '';
    for (let j = i; j < g.length; j++) {
      digits += g[j].digits;
      if (digits.length > 19) break;
      const win = g.slice(i, j + 1);
      // Grouped: the first group has 4 digits and every group 3-6 (4-4-4-4, 4-6-5, 4-4-4-4-3),
      // or every group is one digit ("4 1 1 1 …", a dictated number).
      const grouped =
        j === i || (g[i].digits.length === 4 && win.every((x) => x.digits.length >= 3 && x.digits.length <= 6)) || win.every((x) => x.digits.length === 1);
      if (!grouped || !cardPrefixOk(digits) || !luhnValid(digits)) continue;
      // A comma- or dot-grouped number in an amount context is a list of amounts.
      if (win.slice(1).some((x) => LISTY_SEP.test(x.sep)) && amountContext(text, g[i].start, g[j].end)) continue;
      best = j;
    }
    if (best >= 0) {
      out.push({ start: g[i].start, end: g[best].end, kind: 'card' });
      i = best + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** 3-2-4 SSN windows: three groups split by no comma or line break, standing alone in their run. */
function ssnShapedSpans(text: string, run: DigitRun): Span[] {
  const out: Span[] = [];
  const g = run.groups;
  const apart = (sep: string) => /[,\n]/.test(sep);
  for (let i = run.plus ? 1 : 0; i + 2 < g.length; i++) {
    if (g[i].digits.length !== 3 || g[i + 1].digits.length !== 2 || g[i + 2].digits.length !== 4) continue;
    if (apart(g[i + 1].sep) || apart(g[i + 2].sep)) continue;
    if (i > 0 && !apart(g[i].sep)) continue;
    if (i + 3 < g.length && !apart(g[i + 3].sep)) continue;
    if (amountContext(text, g[i].start, g[i + 2].end)) continue;
    out.push({ start: g[i].start, end: g[i + 2].end, kind: 'ssn' });
  }
  return out;
}

const runDigits = (run: DigitRun) => run.groups.map((x) => x.digits).join('');
const runShape = (run: DigitRun) => run.groups.map((x) => x.digits.length).join('-');

/** The longest prefix of a run with `min`-`max` digits (a keyword's number). */
function prefixSpan(run: DigitRun, min: number, max: number, kind: RedactedKind): Span | null {
  let digits = '';
  let best = -1;
  for (let j = 0; j < run.groups.length; j++) {
    digits += run.groups[j].digits;
    if (digits.length > max) break;
    if (digits.length >= min) best = j;
  }
  return best >= 0 ? { start: run.start, end: run.groups[best].end, kind } : null;
}

function ssnNineValid(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  const area = Number(d.slice(0, 3));
  const group = Number(d.slice(3, 5));
  const serial = Number(d.slice(5));
  if (group === 0 || serial === 0) return false;
  // ITIN: 9XX with group 50-65, 70-88, 90-92 or 94-99. SSN: area 001-899, never 666.
  if (area >= 900) return (group >= 50 && group <= 65) || (group >= 70 && group <= 88) || (group >= 90 && group <= 92) || group >= 94;
  return area !== 0 && area !== 666;
}

function ibanSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(IBAN_COMPACT_RE)) {
    const s = m.index ?? 0;
    if (oneCase(m[0]) && ibanValid(m[0])) out.push({ start: s, end: s + m[0].length, kind: 'iban' });
  }
  for (const m of text.matchAll(IBAN_SPACED_RE)) {
    const s = m.index ?? 0;
    const parts = m[0].split(' ');
    // Longest prefix of whole groups that ends a token and is a valid IBAN.
    for (let n = parts.length; n >= 4; n--) {
      const piece = parts.slice(0, n).join(' ');
      const end = s + piece.length;
      if (/[A-Za-z0-9_\-]/.test(text[end] ?? '')) continue;
      const compact = piece.replace(/ /g, '');
      if (compact.length >= 15 && compact.length <= 34 && oneCase(compact) && ibanValid(compact)) {
        out.push({ start: s, end, kind: 'iban' });
        break;
      }
    }
  }
  return out;
}

function tokenSpans(text: string, re: RegExp, kind: RedactedKind): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(re)) {
    const s = m.index ?? 0;
    if (oneCase(m[0])) out.push({ start: s, end: s + m[0].length, kind });
  }
  return out;
}

/** Keep the first span of each overlap, in priority order (the list order). */
function claim(accepted: Span[], candidates: Span[]): void {
  for (const c of candidates) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue;
    accepted.push(c);
  }
}

interface Detect {
  /** The text the rules read: format characters dropped, every decimal digit as ASCII. */
  text: string;
  /** For each UTF-16 unit of `text`, where it starts and ends in the input (absent: `text` is the input). */
  from?: number[];
  to?: number[];
}

const FORMAT_CHAR = /\p{Cf}/u;
const DECIMAL_DIGIT = /\p{Nd}/u;

/** A non-ASCII decimal digit's value: NFKC for fullwidth and styled digits, else its place in its 0-9 block. */
function digitValue(ch: string): string {
  const k = ch.normalize('NFKC');
  if (/^[0-9]$/.test(k)) return k;
  const cp = ch.codePointAt(0) ?? 0;
  let base = cp;
  // Unicode encodes each script's digits as one contiguous 0-9 block.
  while (base > 0 && cp - base < 60 && DECIMAL_DIGIT.test(String.fromCodePoint(base - 1))) base--;
  return String((cp - base) % 10);
}

/**
 * The copy the rules read, with a map back to the input (review fix): a
 * zero-width or other format character between digits ("4111\u200b1111…")
 * and fullwidth or Devanagari digits ("４１１１", "४१११") no longer hide a
 * number. Linear.
 */
function detectCopy(input: string): Detect {
  if (!/[\p{Cf}]|(?![0-9])\p{Nd}/u.test(input)) return { text: input };
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of input) {
    const end = i + ch.length;
    if (!FORMAT_CHAR.test(ch)) {
      const out = ch.length === 1 && ch >= '0' && ch <= '9' ? ch : DECIMAL_DIGIT.test(ch) ? digitValue(ch) : ch;
      for (let u = 0; u < out.length; u++) {
        text += out[u];
        from.push(i);
        to.push(end);
      }
    }
    i = end;
  }
  return { text, from, to };
}

export function redactSensitive(input: string): Redaction {
  if (typeof input !== 'string' || input.length === 0) return { text: '', kinds: [] };
  const d = detectCopy(input);
  const text = d.text;
  const runs = digitRuns(text, RUN);
  const plain = runs.filter((r) => !r.plus);
  const broad = digitRuns(text, BROAD_RUN);
  const accepted: Span[] = [];

  // Priority: the strictest checks claim first.
  claim(accepted, ibanSpans(text));
  claim(accepted, broad.flatMap((r) => cardSpans(text, r)));
  claim(
    accepted,
    plain.flatMap((r): Span[] => {
      const digits = runDigits(r);
      if (!/^[2-9]\d{11}$/.test(digits) || !verhoeffValid(digits)) return [];
      // Keyword-free 4-4-4 only outside a list of amounts ("amounts 2000 1500 3000").
      const formatted = runShape(r) === '4-4-4' && !amountContext(text, r.start, r.end);
      return formatted || (r.groups.length === 1 && AADHAAR_KW.test(before(text, r.start))) ? [{ start: r.start, end: r.end, kind: 'aadhaar' }] : [];
    }),
  );
  claim(accepted, broad.flatMap((r) => ssnShapedSpans(text, r)));
  claim(accepted, tokenSpans(text, PAN_RE, 'pan'));
  claim(accepted, tokenSpans(text, IFSC_RE, 'ifsc'));
  if (ROUTING_WORD.test(text)) {
    claim(
      accepted,
      plain.filter((r) => abaValid(runDigits(r))).map((r) => ({ start: r.start, end: r.end, kind: 'routing' as const })),
    );
  }
  claim(
    accepted,
    plain.flatMap((r): Span[] => {
      if (!SSN_KW.test(before(text, r.start))) return [];
      return ssnNineValid(runDigits(r)) ? [{ start: r.start, end: r.end, kind: 'ssn' }] : [];
    }),
  );
  claim(
    accepted,
    plain.flatMap((r): Span[] => {
      if (!CVV_KW.test(before(text, r.start)) || r.groups.length !== 1) return [];
      return /^\d{3,4}$/.test(r.groups[0].digits) ? [{ start: r.start, end: r.end, kind: 'cvv' }] : [];
    }),
  );
  claim(
    accepted,
    plain.flatMap((r): Span[] => {
      if (!ACCOUNT_KW.test(before(text, r.start))) return [];
      const span = prefixSpan(r, 6, 18, 'account');
      return span ? [span] : [];
    }),
  );
  // An IFSC or routing number in the message: a bare 8-18 digit number is the
  // account it goes with, unless it is a phone (its shape, or a phone keyword
  // right before it), a date, or written as an amount.
  if (accepted.some((a) => a.kind === 'ifsc' || a.kind === 'routing')) {
    claim(
      accepted,
      plain.flatMap((r): Span[] => {
        const digits = runDigits(r);
        const pieces: Array<{ start: number; end: number; digits: string }> =
          digits.length >= 8 && digits.length <= 18 ? [{ start: r.start, end: r.end, digits }] : r.groups;
        return pieces
          .filter((p) => p.digits.length >= 8 && p.digits.length <= 18 && !PHONE_SHAPE.test(p.digits) && !DATE_SHAPE.test(p.digits))
          .filter((p) => !PHONE_KW.test(before(text, p.start)))
          .filter((p) => !AMOUNT_BEFORE.test(before(text, p.start)) && !AMOUNT_AFTER.test(text.slice(p.end, p.end + 12)))
          .map((p) => ({ start: p.start, end: p.end, kind: 'account' as const }));
      }),
    );
  }

  if (accepted.length === 0) return { text: input, kinds: [] };
  accepted.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  const kinds: RedactedKind[] = [];
  for (const s of accepted) {
    const start = d.from ? d.from[s.start] : s.start;
    const end = d.to ? d.to[s.end - 1] : s.end;
    out += input.slice(at, start) + REDACTION_LABELS[s.kind];
    at = end;
    if (!kinds.includes(s.kind)) kinds.push(s.kind);
  }
  out += input.slice(at);
  return { text: out, kinds };
}
