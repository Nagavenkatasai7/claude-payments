import { describe, it, expect } from 'vitest';
import { RISK_CHAT_CUES, chatRiskCue } from '@/lib/risk-chat-cue';

// Fix pack 6 T21 (R48, P18) — the server-only chat cue: the last 10 customer
// lines, matched on word boundaries (combining marks count as letters, so a
// Devanagari word is never cut inside), plus the scam categories of
// purposeDetailRisk. Pure.

describe('chatRiskCue', () => {
  it.each([
    'jaldi bhejo, kisi ko mat batana',
    'they told me to send it now',
    'तुरंत भेजो',
    'Don’t tell anyone about this',
    'I won the lottery',
    'please do it URGENTLY',
    'keep   this\nsecret',
  ])('fires on %j', (line) => {
    expect(chatRiskCue([line])).toBe(true);
  });

  it.each([
    'send 500 to mom for medicine',
    'maa ki dawai ke liye',
    'the insurgents film was good',
    'hello',
  ])('does not fire on %j', (line) => {
    expect(chatRiskCue([line])).toBe(false);
  });

  it('does not fire on an empty history', () => {
    expect(chatRiskCue([])).toBe(false);
  });

  it('reads only the LAST 10 texts', () => {
    const clean = Array.from({ length: 10 }, (_, i) => `line ${i} for mom`);
    expect(chatRiskCue(['kisi ko mat batana', ...clean])).toBe(false);
    expect(chatRiskCue([...clean.slice(1), 'kisi ko mat batana'])).toBe(true);
    expect(chatRiskCue(['kisi ko mat batana', ...clean.slice(1)])).toBe(true);
  });

  it('skips a non-string entry without throwing', () => {
    expect(() => chatRiskCue([null, undefined, 42, { text: 'urgent' }, ['urgent']])).not.toThrow();
    expect(chatRiskCue([null, undefined, 42, { text: 'urgent' }, ['urgent']])).toBe(false);
    expect(chatRiskCue([null, 'right now please'])).toBe(true);
  });

  it('a Devanagari cue inside a longer word does not fire (combining marks are word characters)', () => {
    // 'जल्दी' followed by a vowel sign continues the word.
    expect(chatRiskCue(['जल्दीे'])).toBe(false);
    expect(chatRiskCue(['जल्दी भेजो'])).toBe(true);
  });
});

describe('RISK_CHAT_CUES', () => {
  it('is frozen per language and every entry is lowercase, trimmed, single-spaced', () => {
    expect(Object.isFrozen(RISK_CHAT_CUES)).toBe(true);
    expect(Object.keys(RISK_CHAT_CUES).sort()).toEqual(['devanagari', 'en', 'hinglish']);
    for (const list of Object.values(RISK_CHAT_CUES)) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      for (const cue of list) {
        expect(cue).toBe(cue.toLowerCase());
        expect(cue).toBe(cue.trim());
        expect(cue).not.toMatch(/\s{2,}|[\t\n\r]/);
      }
    }
  });
});
