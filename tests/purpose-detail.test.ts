import { describe, it, expect } from 'vitest';
import {
  checkPurposeDetail,
  decidePurpose,
  PURPOSE_DETAIL_MAX,
  PURPOSE_DETAIL_MIN,
  PURPOSE_RISK_CATEGORIES,
  PURPOSE_RISK_KEYWORDS,
  PURPOSE_RISK_LABELS,
  PURPOSE_SUGGEST_KEYWORDS,
  PURPOSE_SCAM_WARNING,
  keptPurposeDetail,
  purposeDetailRisk,
  validPurposeDetail,
  type PurposeDetailResult,
} from '@/lib/purpose-detail';
import { TRANSFER_PURPOSES } from '@/lib/purpose-codes';

// Batch B follow-up A1: the "Other" reason box. checkPurposeDetail is the ONE
// rule for the free-text reason (portal, bot, schedules, Partner API).

/** Text of exactly `n` characters (single spaces, no edge space). */
function ofLength(n: number): string {
  let s = 'helping my uncle with roof repairs ';
  while (s.length < n) s += s;
  s = s.slice(0, n);
  return s.endsWith(' ') ? `${s.slice(0, -1)}x` : s;
}

type Want =
  | { ok: false; code: 'missing' | 'too_short' | 'too_long' | 'nonsense' }
  | { ok: true; suggested?: string; risk?: string };

const TABLE: Array<[string, unknown, Want]> = [
  // ── missing / length ──
  ['undefined', undefined, { ok: false, code: 'missing' }],
  ['null', null, { ok: false, code: 'missing' }],
  ['a number', 1234567890, { ok: false, code: 'missing' }],
  ['empty', '', { ok: false, code: 'missing' }],
  ['only spaces and controls', ' \n\t \u0000 ', { ok: false, code: 'missing' }],
  ['9 characters', 'rent home', { ok: false, code: 'too_short' }],
  ['10 characters', 'rent house', { ok: true, suggested: 'bills' }],
  ['120 characters', ofLength(120), { ok: true }],
  ['121 characters', ofLength(121), { ok: false, code: 'too_long' }],
  ['padding does not count', '   rent  house   ', { ok: true, suggested: 'bills' }],
  // ── nonsense ──
  ['digits only', '1234567890', { ok: false, code: 'nonsense' }],
  ['punctuation only', '!!!???....,,,', { ok: false, code: 'nonsense' }],
  ['emoji only', '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂', { ok: false, code: 'nonsense' }],
  ['one letter repeated', 'aaaaaaaaaa', { ok: false, code: 'nonsense' }],
  ['two distinct letters', 'ababab abab', { ok: false, code: 'nonsense' }],
  ['keyboard run asdf', 'asdfasdfasdf', { ok: false, code: 'nonsense' }],
  ['keyboard run qwerty', 'qwerty qwerty', { ok: false, code: 'nonsense' }],
  ['xxxx words', 'xxxx xxxx xxxx', { ok: false, code: 'nonsense' }],
  ['test test', 'test test test', { ok: false, code: 'nonsense' }],
  ['filler: send money', 'send money', { ok: false, code: 'nonsense' }],
  ['filler: no reason', 'No reason, personal', { ok: false, code: 'nonsense' }],
  ['filler: n/a others', 'n/a others none', { ok: false, code: 'nonsense' }],
  ['filler + glue words', 'money for my transfer', { ok: false, code: 'nonsense' }],
  ['filler, any case', 'MISC PAYMENT OK', { ok: false, code: 'nonsense' }],
  // ── valid, a single suggestion ──
  ['school fees', 'school fees for my son', { ok: true, suggested: 'education' }],
  ['Hinglish medical', 'maa ki dawai ke liye', { ok: true, suggested: 'medical' }],
  ['Hinglish padhai', 'bhai ki padhai ke liye', { ok: true, suggested: 'education' }],
  ['hospital', 'Dad is in hospital this week', { ok: true, suggested: 'medical' }],
  ['Hinglish rent', 'ghar ka kiraya dena hai', { ok: true, suggested: 'bills' }],
  ['bijli', 'bijli ka paisa dena hai', { ok: true, suggested: 'bills' }],
  ['wedding', "cousin's wedding shopping", { ok: true, suggested: 'gift' }],
  ['Hinglish shaadi', 'behen ki shaadi ke liye', { ok: true, suggested: 'gift' }],
  ['household', 'monthly household expenses', { ok: true, suggested: 'family_support' }],
  ['ghar kharcha', 'ghar kharcha for this month', { ok: true, suggested: 'family_support' }],
  ['fixed deposit', 'put it in a fixed deposit', { ok: true, suggested: 'savings' }],
  ['bachat', 'apni bachat ke liye rakhna', { ok: true, suggested: 'savings' }],
  ['supplier', 'paying my supplier in Pune', { ok: true, suggested: 'business' }],
  ['family word loses to a specific reason', "mom's birthday celebration", { ok: true, suggested: 'gift' }],
  // ── valid, no suggestion ──
  ['nothing matches', 'helping a neighbour repair the roof', { ok: true }],
  ['ambiguous: medical and bills', 'hospital ka bill bharna hai', { ok: true }],
  ['ambiguous: education and business', 'college books for my shop', { ok: true }],
  ['word boundary: "billion" is not a bill', 'one billion thanks to uncle', { ok: true }],
  ['word boundary: "shopping" is not a shop', 'shopping for the new house', { ok: true }],
  ['Devanagari text is valid', 'माँ के इलाज के लिए पैसे', { ok: true }],
  // ── risk ──
  ['prize', 'to claim my lottery prize', { ok: true, risk: 'prize' }],
  ['prize Hinglish', 'inaam ka paisa lena hai', { ok: true, risk: 'prize' }],
  ['investment', 'bitcoin to grow my money', { ok: true, risk: 'investment' }],
  ['investment Hinglish', 'paisa double karna hai jaldi', { ok: true, risk: 'investment' }],
  ['advance fee', 'processing fee for my loan', { ok: true, risk: 'advance_fee' }],
  ['delivery', 'customs charge for a parcel', { ok: true, risk: 'delivery' }],
  ['romance', 'helping a friend I met online', { ok: true, risk: 'romance' }],
  ['job', 'visa fee for the new job abroad', { ok: true, risk: 'job' }],
  ['authority', 'police said I must pay to avoid arrest', { ok: true, risk: 'authority' }],
  ['gambling', 'satta khelne ke liye paisa', { ok: true, risk: 'gambling' }],
  ['risk with a suggestion', 'registration fee for college admission', { ok: true, suggested: 'education', risk: 'advance_fee' }],
  // ── risk: plural and longer forms (security review M1) ──
  ['crypto is a prefix: cryptocurrency', 'cryptocurrency investment plan', { ok: true, risk: 'investment' }],
  ['bitcoin is a prefix: bitcoins', 'buying bitcoins for uncle', { ok: true, risk: 'investment' }],
  ['plural: lottery -> lotteries', 'won lotteries abroad', { ok: true, risk: 'prize' }],
  ['plural: prizes', 'claim my prizes from contest', { ok: true, risk: 'prize' }],
  ['plural: parcels', 'parcels stuck at airport', { ok: true, risk: 'delivery' }],
  ['plural on a phrase: release payments', 'release payments for my account', { ok: true, risk: 'advance_fee' }],
  ['phrase: pay fine', 'pay fine to the officer today', { ok: true, risk: 'authority' }],
  ['phrase: paying the fine', 'paying the fine they asked for', { ok: true, risk: 'authority' }],
  ['phrase: fine payment', 'fine payment for the notice', { ok: true, risk: 'authority' }],
  ['phrase: court fee', 'court fee before the hearing', { ok: true, risk: 'authority' }],
  ['phrase: court case fee', 'court case fee for my brother', { ok: true, risk: 'authority' }],
  ['phrase: trading account', 'top up my trading account', { ok: true, risk: 'investment' }],
  ['phrase: trading profits', 'release my trading profits', { ok: true, risk: 'investment' }],
  ['phrase: trading platform', 'money on a trading platform', { ok: true, risk: 'investment' }],
  // ── no risk: ordinary words that used to over-trigger (security review M1) ──
  ['"fine" alone is not a fine', 'I am fine, sending for house', { ok: true }],
  ['"court" alone is not a court', 'food court shop rent payment', { ok: true }],
  ['"trading" alone is not investment', 'trading goods with supplier', { ok: true, suggested: 'business' }],
  // ── suggestion: plural forms ──
  ['suggest plural: hospitals', 'visits to two hospitals', { ok: true, suggested: 'medical' }],
  ['suggest plural: universities', 'universities application costs', { ok: true, suggested: 'education' }],
];

describe('checkPurposeDetail', () => {
  it('has at least 40 cases', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(40);
  });

  it.each(TABLE)('%s', (_name, input, want) => {
    const r: PurposeDetailResult = checkPurposeDetail(input);
    if (!want.ok) {
      expect(r).toEqual({ ok: false, code: want.code });
      return;
    }
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggested).toBe(want.suggested);
    expect(r.risk?.category).toBe(want.risk);
  });

  it('pins the boundary lengths', () => {
    expect(PURPOSE_DETAIL_MIN).toBe(10);
    expect(PURPOSE_DETAIL_MAX).toBe(120);
    expect(ofLength(9)).toHaveLength(9);
    expect(ofLength(120)).toHaveLength(120);
    expect(ofLength(121)).toHaveLength(121);
    expect(checkPurposeDetail(ofLength(9))).toEqual({ ok: false, code: 'too_short' });
    expect(checkPurposeDetail(ofLength(10)).ok).toBe(true);
    expect(checkPurposeDetail(ofLength(120)).ok).toBe(true);
    expect(checkPurposeDetail(ofLength(121))).toEqual({ ok: false, code: 'too_long' });
  });

  it('returns the normalised text: trimmed, whitespace collapsed, control and format characters removed', () => {
    const r = checkPurposeDetail('  school\n\tfees​  for   my son\u0007 ');
    expect(r).toMatchObject({ ok: true, detail: 'school fees for my son' });
  });

  it('counts characters, not UTF-16 units', () => {
    expect(checkPurposeDetail('माँ का इलाज').ok).toBe(true);
  });
});

describe('decidePurpose (the A3 rule)', () => {
  it('a purpose other than other ignores the detail', () => {
    expect(decidePurpose('education', 'lottery prize money for me')).toEqual({ ok: true, purpose: 'education' });
    expect(decidePurpose('gift', undefined)).toEqual({ ok: true, purpose: 'gift' });
  });

  it('other needs a valid detail', () => {
    expect(decidePurpose('other', undefined)).toEqual({ ok: false, code: 'missing' });
    expect(decidePurpose('other', 'send money')).toEqual({ ok: false, code: 'nonsense' });
    expect(decidePurpose('other', 'x'.repeat(200))).toEqual({ ok: false, code: 'too_long' });
  });

  it('other with a suggestion becomes the suggested purpose and keeps the detail', () => {
    expect(decidePurpose('other', ' school fees ')).toEqual({ ok: true, purpose: 'education', detail: 'school fees', fromDetail: true });
  });

  it('other with no suggestion stays other and keeps the detail', () => {
    expect(decidePurpose('other', 'helping a neighbour repair the roof')).toEqual({
      ok: true, purpose: 'other', detail: 'helping a neighbour repair the roof',
    });
  });

  it('carries the risk category', () => {
    expect(decidePurpose('other', 'to claim my lottery prize')).toEqual({
      ok: true, purpose: 'other', detail: 'to claim my lottery prize', risk: 'prize',
    });
  });
});

describe('exported lists', () => {
  it('names every risk category with a staff label and keywords', () => {
    expect([...PURPOSE_RISK_CATEGORIES].sort()).toEqual(
      ['advance_fee', 'authority', 'delivery', 'gambling', 'investment', 'job', 'prize', 'romance'],
    );
    for (const c of PURPOSE_RISK_CATEGORIES) {
      expect(PURPOSE_RISK_KEYWORDS[c].length).toBeGreaterThan(0);
      expect(PURPOSE_RISK_LABELS[c]).toMatch(/\w/);
    }
  });

  it('has suggestion keywords for every purpose but other', () => {
    for (const p of TRANSFER_PURPOSES) {
      if (p === 'other') expect(PURPOSE_SUGGEST_KEYWORDS[p]).toBeUndefined();
      else expect(PURPOSE_SUGGEST_KEYWORDS[p]?.length).toBeGreaterThan(0);
    }
  });
});

describe('validPurposeDetail and the warning copy', () => {
  it('keeps a valid reason, drops anything else', () => {
    expect(validPurposeDetail('  school fees ')).toBe('school fees');
    expect(validPurposeDetail('send money')).toBeUndefined();
    expect(validPurposeDetail(42)).toBeUndefined();
  });

  it('the warning is the owner-approved text (it names no matched rule)', () => {
    expect(PURPOSE_SCAM_WARNING).toBe(
      'Stop and check. Scammers ask people to send money for prizes, loans, investments, parcels, jobs or people met online. ' +
        'SmartRemit staff check this transfer before the money goes.',
    );
  });
});

describe('keptPurposeDetail (security review L2: an invalid reason that matches a scam pattern is kept)', () => {
  it('keeps a valid reason, normalised, with its risk', () => {
    expect(keptPurposeDetail('  school fees ')).toEqual({ detail: 'school fees' });
    expect(keptPurposeDetail('to claim my lottery prize')).toEqual({ detail: 'to claim my lottery prize', risk: 'prize' });
  });

  it('drops an absent or invalid reason with no scam pattern', () => {
    for (const raw of [undefined, null, 42, '', '   ', 'short', 'send money', ofLength(121)]) {
      expect(keptPurposeDetail(raw), String(raw)).toBeUndefined();
    }
  });

  it('keeps a too-short reason that matches a scam pattern, as written', () => {
    expect(keptPurposeDetail(' lottery ')).toEqual({ detail: 'lottery', risk: 'prize' });
    expect(keptPurposeDetail('bitcoins')).toEqual({ detail: 'bitcoins', risk: 'investment' });
  });

  it('cuts a too-long risky reason to 120 characters and keeps the matched words', () => {
    const head = `${'we are helping my uncle with the roof repairs at home '.repeat(4)}`;
    const raw = `${head}and he said there is a lottery prize to claim`;
    expect([...raw].length).toBeGreaterThan(PURPOSE_DETAIL_MAX);
    const kept = keptPurposeDetail(raw);
    expect(kept?.risk).toBe('prize');
    expect([...(kept?.detail ?? '')].length).toBeLessThanOrEqual(PURPOSE_DETAIL_MAX);
    expect(kept?.detail).toContain('lottery');
    // Kept text is stable: keeping it again gives the same result (the mint re-checks it).
    expect(keptPurposeDetail(kept?.detail)).toEqual(kept);

    const early = `lottery prize ${ofLength(200)}`;
    const keptEarly = keptPurposeDetail(early);
    expect(keptEarly?.detail.startsWith('lottery prize')).toBe(true);
    expect([...(keptEarly?.detail ?? '')].length).toBeLessThanOrEqual(PURPOSE_DETAIL_MAX);
  });

  it('purposeDetailRisk names the risk of a kept short reason too (staff views)', () => {
    expect(purposeDetailRisk('lottery')).toBe('prize');
    expect(purposeDetailRisk('short')).toBeUndefined();
    expect(purposeDetailRisk(undefined)).toBeUndefined();
  });
});
