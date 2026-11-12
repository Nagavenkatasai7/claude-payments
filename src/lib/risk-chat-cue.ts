import { purposeDetailRisk } from './purpose-detail';
import { boundUntrustedText } from './untrusted-text';

// Fix pack 6 (R48, P18) — the chat cue risk signal: does the customer's recent
// chat read like someone is pushing them (urgency, secrecy, a third party who
// "told me to send", remote-access tools, gift cards) or like a known scam
// pattern (purposeDetailRisk's categories)?
//
// SERVER-only: it imports purpose-detail and untrusted-text, which reach
// `node:url`. Never import it from a 'use client' file or from risk-signals.ts
// (which client bundles reach, P0 rule 13; tests/client-import-chain.test.ts).
// The caller passes only the boolean on (TurnContext.chatRiskCue, T26a); this
// module never logs or stores a matched word or the chat text (P0 rule 5).
// Pure.

/**
 * DRAFT for the partner's MLRO (R48, Q-R48.2): the cue phrases, lowercase,
 * single-spaced. A phrase matches on word boundaries, any whitespace between
 * its words.
 */
export const RISK_CHAT_CUES: Readonly<{
  en: readonly string[];
  hinglish: readonly string[];
  devanagari: readonly string[];
}> = Object.freeze({
  en: Object.freeze([
    'urgent', 'urgently', 'right now', 'immediately', "don't tell anyone", 'do not tell anyone',
    'keep it secret', 'keep this secret', 'they told me to send', 'he told me to send', 'she told me to send',
    'told me to pay', 'remote access', 'anydesk', 'teamviewer', 'gift card', 'gift cards', 'stay on the line',
  ]),
  hinglish: Object.freeze([
    'jaldi', 'turant', 'abhi bhejo', 'kisi ko mat batana', 'kisiko mat batana', 'kisi ko mat bolna',
    'unhone bola bhejne ko',
  ]),
  devanagari: Object.freeze(['तुरंत', 'जल्दी', 'अभी भेजो', 'किसी को मत बताना', 'किसी को मत बोलना']),
});

/** How many of the latest chat lines are read. */
const CUE_WINDOW = 10;
/** Each line is bounded to this many characters before matching. */
const CUE_LINE_MAX = 1000;

/**
 * A phrase on Unicode word boundaries. Unlike purpose-detail's matcher, combining
 * marks (\p{M}) count as word characters too: Devanagari vowel signs are marks,
 * so a cue never matches the start of a longer word. Special characters are
 * escaped; a space matches any whitespace run.
 */
function cueRegex(phrase: string): RegExp {
  const source = phrase
    .normalize('NFKC')
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${source}(?![\\p{L}\\p{M}\\p{N}])`, 'u');
}

const CUE_REGEXES: readonly RegExp[] = Object.freeze(
  [...RISK_CHAT_CUES.en, ...RISK_CHAT_CUES.hinglish, ...RISK_CHAT_CUES.devanagari].map(cueRegex),
);

/**
 * True when any of the last 10 entries carries a cue or a scam pattern.
 * Non-string entries are skipped. Known limit: purposeDetailRisk reads only the
 * first 480 characters of each line (its own bound).
 */
export function chatRiskCue(texts: readonly unknown[]): boolean {
  for (const raw of texts.slice(-CUE_WINDOW)) {
    if (typeof raw !== 'string') continue;
    const text = boundUntrustedText(raw, CUE_LINE_MAX).replace(/[‘’]/g, "'").toLowerCase();
    if (!text) continue;
    if (CUE_REGEXES.some((re) => re.test(text))) return true;
    if (purposeDetailRisk(text) !== undefined) return true;
  }
  return false;
}
