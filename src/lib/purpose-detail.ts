import { boundUntrustedText } from './untrusted-text';
import type { TransferPurpose } from './types';

// purpose-detail — the "Other" reason box (Batch B follow-up A1, owner request
// 2026-10-08). When a customer picks purpose `other`, they must say in a few
// words why they send the money. This module is the ONE rule for that text,
// used by the portal (send, send again, schedules), the bot's send tools and
// the Partner API:
//  • checkPurposeDetail normalises the text and refuses it when it is missing,
//    too short, too long or nonsense;
//  • it SUGGESTS one of the 7 named purposes when exactly one matches a
//    keyword (English and Hinglish in Roman letters);
//  • it flags SCAM PATTERNS (prizes, investments, advance fees, parcels,
//    people met online, job fees, threats from "authorities", gambling). A risk
//    hit holds the transfer for staff review (transfer-create.ts mintLocked).
//    The customer and the partner API NEVER learn which rule fired or the
//    category; only staff pages name it (PURPOSE_RISK_LABELS).
// Pure; no I/O.

export const PURPOSE_DETAIL_MIN = 10;
export const PURPOSE_DETAIL_MAX = 120;

export type PurposeDetailCode = 'missing' | 'too_short' | 'too_long' | 'nonsense';

export const PURPOSE_RISK_CATEGORIES = [
  'prize', 'investment', 'advance_fee', 'delivery', 'romance', 'job', 'authority', 'gambling',
] as const;
export type PurposeRiskCategory = (typeof PURPOSE_RISK_CATEGORIES)[number];

export type PurposeDetailResult =
  | { ok: true; detail: string; suggested?: TransferPurpose; risk?: { category: PurposeRiskCategory } }
  | { ok: false; code: PurposeDetailCode };

/**
 * Keywords that suggest a named purpose. Matched on word boundaries, case-insensitive; the last
 * word also matches its plural (s / es, and y -> ies), so "hospitals" and "universities" match.
 */
export const PURPOSE_SUGGEST_KEYWORDS: Readonly<Partial<Record<TransferPurpose, readonly string[]>>> = {
  education: ['school', 'college', 'tuition', 'fees', 'exam', 'university', 'padhai', 'books'],
  medical: ['hospital', 'medicine', 'medicines', 'doctor', 'surgery', 'treatment', 'operation', 'dawai', 'ilaj', 'clinic'],
  bills: ['rent', 'electricity', 'bill', 'bills', 'emi', 'mortgage', 'water bill', 'phone bill', 'kiraya', 'bijli'],
  gift: ['gift', 'birthday', 'wedding', 'shaadi', 'anniversary', 'festival gift', 'tohfa'],
  family_support: [
    'family', 'parents', 'mother', 'father', 'mom', 'dad', 'maa', 'papa', 'household', 'ghar kharcha', 'kharcha',
  ],
  savings: ['savings', 'deposit', 'fixed deposit', 'bachat'],
  business: ['business', 'invoice', 'supplier', 'vendor', 'salary for staff', 'shop'],
};

/**
 * Scam-pattern keywords per risk category. Matched like the suggestion keywords (word boundaries,
 * case-insensitive, plural last word); a trailing `*` makes the keyword a PREFIX ("crypto*" matches
 * "cryptocurrency", "bitcoin*" matches "bitcoins"). Ordinary words that mean something harmless on
 * their own ("fine", "court", "trading") only count inside a phrase.
 */
export const PURPOSE_RISK_KEYWORDS: Readonly<Record<PurposeRiskCategory, readonly string[]>> = {
  prize: ['lottery', 'prize', 'lucky draw', 'jackpot', 'winning', 'inaam'],
  investment: [
    'crypto*', 'bitcoin*', 'forex', 'trading account', 'trading profit', 'trading platform', 'investment return',
    'double money', 'guaranteed return', 'paisa double',
  ],
  advance_fee: ['processing fee', 'loan fee', 'advance fee', 'registration fee', 'unlock fee', 'release fee', 'release payment'],
  delivery: ['customs', 'parcel', 'courier fee', 'clearance fee'],
  romance: ['online friend', 'met online', 'dating', 'never met'],
  job: ['job fee', 'visa fee', 'placement fee'],
  authority: [
    'police', 'arrest', 'tax refund', 'irs', 'cbi', 'pay fine', 'pay a fine', 'pay the fine', 'paying fine',
    'paying a fine', 'paying the fine', 'fine payment', 'court fee', 'court case fee',
  ],
  gambling: ['betting', 'casino', 'gambling', 'satta'],
};

/** Staff-only names for the risk categories (admin, compliance and partner transfer pages). */
export const PURPOSE_RISK_LABELS: Readonly<Record<PurposeRiskCategory, string>> = {
  prize: 'Prize or lottery',
  investment: 'Investment or crypto',
  advance_fee: 'Advance fee',
  delivery: 'Parcel or customs',
  romance: 'Person met online',
  job: 'Job or visa fee',
  authority: 'Police, tax or court threat',
  gambling: 'Gambling',
};

/** Words that say nothing about the reason. A text made only of these is nonsense. */
export const PURPOSE_DETAIL_FILLER: readonly string[] = [
  'na', 'n/a', 'other', 'others', 'none', 'nothing', 'no reason', 'personal', 'misc', 'test', 'ok', 'send',
  'money', 'transfer', 'payment',
];

// Glue words neither count as a reason nor make a text nonsense on their own:
// "money for my transfer" is still only filler. A text of glue words alone is
// nonsense too.
const GLUE = new Set([
  'a', 'an', 'the', 'for', 'to', 'of', 'and', 'my', 'me', 'i', 'is', 'it', 'this', 'that', 'just', 'some',
  'ke', 'ki', 'ka', 'ko', 'liye', 'hai', 'se', 'ye', 'yeh', 'mera', 'meri', 'mere',
]);

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const KEYBOARD_LINES = [...KEYBOARD_ROWS, ...KEYBOARD_ROWS.map((r) => [...r].reverse().join(''))];

const LETTER = /\p{L}/u;
const LETTER_ALL = /\p{L}/gu;

/** A lowercase phrase with single spaces as a regex source: special characters escaped, any whitespace between words. */
function phraseSource(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+');
}

/** A regex source matched on Unicode word boundaries. */
function bounded(source: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, 'u');
}

/** A compiled keyword: lowercase phrase with single spaces, matched on Unicode word boundaries. */
function wordRegex(phrase: string): RegExp {
  return bounded(phraseSource(phrase));
}

/**
 * A compiled suggestion or risk keyword: like wordRegex, but the last word also matches its plural
 * (s / es; a consonant + y ending also matches ies: lottery -> lotteries), and a trailing `*` turns
 * the keyword into a prefix (crypto* matches cryptocurrency).
 */
function keywordRegex(keyword: string): RegExp {
  if (keyword.endsWith('*')) return bounded(`${phraseSource(keyword.slice(0, -1))}[\\p{L}\\p{N}]*`);
  if (/[^aeiou]y$/.test(keyword)) return bounded(`${phraseSource(keyword.slice(0, -1))}(?:y|ies)`);
  return bounded(`${phraseSource(keyword)}(?:e?s)?`);
}

const SUGGEST_MATCHERS: ReadonlyArray<[TransferPurpose, RegExp[]]> = Object.entries(PURPOSE_SUGGEST_KEYWORDS).map(
  ([p, words]) => [p as TransferPurpose, (words ?? []).map(keywordRegex)],
);
const RISK_MATCHERS: ReadonlyArray<[PurposeRiskCategory, RegExp[]]> = PURPOSE_RISK_CATEGORIES.map(
  (c) => [c, PURPOSE_RISK_KEYWORDS[c].map(keywordRegex)],
);
const FILLER_PHRASES = PURPOSE_DETAIL_FILLER.filter((w) => w.includes(' '));
const FILLER_WORDS = new Set(PURPOSE_DETAIL_FILLER.filter((w) => !w.includes(' ')));

/** The token is a keyboard run (asdf, qwerty, poiuy) or a repeat of one (asdfasdf). */
function isKeyboardRun(token: string): boolean {
  if (token.length < 4 || !/^[a-z]+$/.test(token)) return false;
  for (let unit = 3; unit <= token.length; unit++) {
    if (token.length % unit !== 0) continue;
    const head = token.slice(0, unit);
    if (head.repeat(token.length / unit) !== token) continue;
    if (KEYBOARD_LINES.some((line) => line.includes(head))) return true;
  }
  return false;
}

/** The token is one letter repeated (xxxx). */
function isRepeatedLetter(token: string): boolean {
  return token.length >= 3 && [...token].every((ch) => ch === token[0]);
}

function isNonsense(lower: string): boolean {
  const letters = lower.match(LETTER_ALL) ?? [];
  // Only digits, punctuation or emoji; or fewer than 3 distinct letters ("aaaaaaaaaa", "ababab").
  if (letters.length === 0 || new Set(letters).size < 3) return true;
  let text = lower;
  for (const phrase of FILLER_PHRASES) text = text.replace(wordRegex(phrase), ' na ');
  const tokens = text.split(/[^\p{L}\p{N}/]+/u).filter((t) => LETTER.test(t));
  // Every word is filler, glue, a keyboard run or a repeated letter.
  return tokens.every((t) => FILLER_WORDS.has(t) || GLUE.has(t) || isKeyboardRun(t) || isRepeatedLetter(t));
}

function suggest(lower: string): TransferPurpose | undefined {
  let hits = SUGGEST_MATCHERS.filter(([, res]) => res.some((re) => re.test(lower))).map(([p]) => p);
  // A family word names WHO the money is for, not WHAT it is for: "maa ki dawai"
  // is medical. When a specific reason matches too, the family word steps aside.
  if (hits.length > 1) hits = hits.filter((p) => p !== 'family_support');
  return hits.length === 1 ? hits[0] : undefined;
}

function riskOf(lower: string): PurposeRiskCategory | undefined {
  return RISK_MATCHERS.find(([, res]) => res.some((re) => re.test(lower)))?.[0];
}

/** Where the first scam-pattern keyword starts (UTF-16 index), or -1. */
function firstRiskIndex(lower: string): number {
  let first = -1;
  for (const [, res] of RISK_MATCHERS) {
    for (const re of res) {
      const i = lower.search(re);
      if (i >= 0 && (first < 0 || i < first)) first = i;
    }
  }
  return first;
}

/**
 * Check the free-text reason for purpose `other`. Normalises (string only,
 * NFKC, control and invisible characters removed, whitespace collapsed,
 * trimmed), then refuses `missing` (absent or blank), `too_short` (< 10
 * characters), `too_long` (> 120) or `nonsense`. A valid text comes back
 * normalised, with `suggested` when exactly one named purpose matches and
 * `risk` when a scam pattern matches (both may be set). Pure.
 */
export function checkPurposeDetail(raw: unknown): PurposeDetailResult {
  if (typeof raw !== 'string') return { ok: false, code: 'missing' };
  // boundUntrustedText caps with an ellipsis, so give it room past the max: a
  // longer text is still longer than the max after the cap.
  const detail = boundUntrustedText(raw, PURPOSE_DETAIL_MAX * 4);
  if (detail === '') return { ok: false, code: 'missing' };
  const length = [...detail].length;
  if (length < PURPOSE_DETAIL_MIN) return { ok: false, code: 'too_short' };
  if (length > PURPOSE_DETAIL_MAX) return { ok: false, code: 'too_long' };
  const lower = detail.toLowerCase();
  if (isNonsense(lower)) return { ok: false, code: 'nonsense' };
  const out: PurposeDetailResult = { ok: true, detail };
  const suggested = suggest(lower);
  if (suggested) out.suggested = suggested;
  const category = riskOf(lower);
  if (category) out.risk = { category };
  return out;
}

export type PurposeDecision =
  | {
      ok: true;
      purpose: TransferPurpose;
      /** The normalised reason (only when the chosen purpose was `other`). */
      detail?: string;
      /** True when the reason's words turned `other` into a named purpose. */
      fromDetail?: true;
      /** Staff-only: the scam pattern the reason matches. Never shown to the customer or a partner API caller. */
      risk?: PurposeRiskCategory;
    }
  | { ok: false; code: PurposeDetailCode };

/**
 * The A3 rule: purpose `other` REQUIRES a valid reason; any other purpose
 * ignores one. When the reason suggests a named purpose, the purpose becomes
 * that one and the reason is kept. Pure.
 */
export function decidePurpose(purpose: TransferPurpose, rawDetail: unknown): PurposeDecision {
  if (purpose !== 'other') return { ok: true, purpose };
  const r = checkPurposeDetail(rawDetail);
  if (!r.ok) return { ok: false, code: r.code };
  const out: PurposeDecision = { ok: true, purpose: r.suggested ?? 'other', detail: r.detail };
  if (r.suggested) out.fromDetail = true;
  if (r.risk) out.risk = r.risk.category;
  return out;
}

/**
 * The risk category of a STORED reason (staff views and the portal warning). A stored reason is
 * valid or, since security review L2, an invalid one kept because it matches a scam pattern
 * (keptPurposeDetail), so the scam check runs on the text whatever its length. Pure.
 */
export function purposeDetailRisk(detail: string | null | undefined): PurposeRiskCategory | undefined {
  if (!detail) return undefined;
  return riskOf(boundUntrustedText(detail, PURPOSE_DETAIL_MAX * 4).toLowerCase());
}

/**
 * The reason a send keeps (security review L2). A valid reason comes back normalised, with its
 * risk. An INVALID one (too short, too long, nonsense) that still matches a scam pattern is kept
 * too, so the mint can hold it: when the bot's purpose.detect switch is off, `other` with an
 * invalid reason goes on without asking, and a dropped "lottery" would have gone unchecked. A
 * kept text is at most PURPOSE_DETAIL_MAX characters: a longer one is cut to the first 120, or,
 * when the scam words come later, to 120 starting at them (after an ellipsis). Anything else is
 * undefined. Keeping a kept text again gives the same result (the mint re-checks it). Pure.
 */
export function keptPurposeDetail(raw: unknown): { detail: string; risk?: PurposeRiskCategory } | undefined {
  const r = checkPurposeDetail(raw);
  if (r.ok) return r.risk ? { detail: r.detail, risk: r.risk.category } : { detail: r.detail };
  if (r.code === 'missing') return undefined;
  const text = boundUntrustedText(raw, PURPOSE_DETAIL_MAX * 4);
  const at = firstRiskIndex(text.toLowerCase());
  if (at < 0) return undefined;
  let detail = boundUntrustedText(text, PURPOSE_DETAIL_MAX);
  let risk = riskOf(detail.toLowerCase());
  if (!risk) {
    detail = boundUntrustedText(`…${text.slice(at)}`, PURPOSE_DETAIL_MAX);
    risk = riskOf(detail.toLowerCase());
  }
  return risk ? { detail, risk } : undefined;
}

/** A valid reason, normalised; anything else (absent, invalid) is undefined. Pure. */
export function validPurposeDetail(raw: unknown): string | undefined {
  const r = checkPurposeDetail(raw);
  return r.ok ? r.detail : undefined;
}

/**
 * The customer-facing scam warning (portal review, Send again, schedules and the
 * bot). Deliberately names no rule and no category: the customer is never told
 * which words matched.
 */
export const PURPOSE_SCAM_WARNING =
  'Stop and check. Scammers ask people to send money for prizes, loans, investments, parcels, jobs or people met online. ' +
  'SmartRemit staff check this transfer before the money goes.';

/** What a send tool tells the model when purpose `other` has no valid reason (never shown to the customer as is). */
export const PURPOSE_DETAIL_HINT =
  'The customer chose Other. Ask them ONCE, in a few words, what the money is for: "What is it for?" ' +
  '(in Hinglish for a Hinglish customer: "Yeh paise kis liye hain?"). Then call the same tool again with the same ' +
  "details, purpose 'other' and purpose_detail set to their own words (10 to 120 characters). Never write the reason " +
  'yourself. If they already answered and this came back again, their answer was too short or unclear: ask them to say a little more.';
