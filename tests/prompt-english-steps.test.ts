// Fix pack 6 T12 (P12, Q-R46.2): the optional ENGLISH TRANSACTION STEPS section.
// On only for a live-certified routed partner; absent or false keeps every prompt
// (and its promptHash) byte-for-byte what it was.
import { describe, expect, it } from 'vitest';
import {
  ENGLISH_STEPS_SECTION,
  PROVIDER_TRAILER,
  SYSTEM_PROMPT,
  VOICE_TRAILER,
  buildSystemPrompt,
} from '@/lib/prompt';
import { promptHash } from '@/lib/ai-provenance';
import { toolSchemasForChannel } from '@/lib/tools';

const LINE = 'Payments by Acme Money Services LLC, licensed by State Department of Financial Services';
const BRANDED = { brand: 'SmartRemit', botPersona: 'Warm and brief.', providerLine: LINE } as const;

describe('ENGLISH TRANSACTION STEPS section (pack 6 P12)', () => {
  it('absent, false or undefined -> byte-identical', () => {
    expect(buildSystemPrompt({ brand: 'SmartRemit', englishTransactionSteps: false })).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({ brand: 'SmartRemit', englishTransactionSteps: undefined })).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({ brand: 'SmartRemit' })).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toContain(ENGLISH_STEPS_SECTION);
    expect(SYSTEM_PROMPT).not.toContain('ENGLISH TRANSACTION STEPS');
    const branded = buildSystemPrompt({ ...BRANDED });
    expect(buildSystemPrompt({ ...BRANDED, englishTransactionSteps: false })).toBe(branded);
    expect(branded).not.toContain('ENGLISH TRANSACTION STEPS');
  });

  it('true -> exactly one ENGLISH_STEPS_SECTION, after PROVIDER and before BRAND VOICE; VOICE_TRAILER stays last', () => {
    const p = buildSystemPrompt({ ...BRANDED, englishTransactionSteps: true });
    expect(p.split(ENGLISH_STEPS_SECTION).length).toBe(2);
    expect(p.split('ENGLISH TRANSACTION STEPS').length).toBe(2);
    expect(p).toContain(`${PROVIDER_TRAILER}\n\n${ENGLISH_STEPS_SECTION}\n\nBRAND VOICE (tone only)`);
    expect(p.indexOf('\n\nPROVIDER\n')).toBeLessThan(p.indexOf(ENGLISH_STEPS_SECTION));
    expect(p.indexOf(ENGLISH_STEPS_SECTION)).toBeLessThan(p.indexOf('BRAND VOICE (tone only)'));
    expect(p.endsWith(VOICE_TRAILER)).toBe(true);
    // Removing the section gives back the build without the flag.
    expect(p.replace(`\n\n${ENGLISH_STEPS_SECTION}`, '')).toBe(buildSystemPrompt({ ...BRANDED }));
  });

  it('true with neither a provider line nor a persona -> the prompt ends with the section', () => {
    const p = buildSystemPrompt({ brand: 'SmartRemit', englishTransactionSteps: true });
    expect(p).toBe(`${SYSTEM_PROMPT}\n\n${ENGLISH_STEPS_SECTION}`);
    expect(p.endsWith(ENGLISH_STEPS_SECTION)).toBe(true);
  });

  it('the section names each verbatim part and keeps other chat in the customer language', () => {
    const s = ENGLISH_STEPS_SECTION;
    expect(s.startsWith('ENGLISH TRANSACTION STEPS\n')).toBe(true);
    for (const w of ['quote', 'confirmation question', 'pay link', 'status', 'reply_to_customer', 'reply_hint', 'ONE']) {
      expect(s, w).toContain(w);
    }
    expect(s).toMatch(/word for word/);
    expect(s).toMatch(/stays? in the customer's language/);
    const t = s.toLowerCase();
    // No partner, regulator or certification, and no internal term (bot-content guard list).
    for (const term of [
      'partner', 'regulator', 'licens', 'certif', 'counsel', 'corridor', 'watchlist', 'sanctions',
      'compliance', 'payout', 'aml', 'reg e', 'smartremit',
    ]) {
      expect(t, term).not.toContain(term);
    }
  });

  it('promptHash differs only when the flag is on', () => {
    const tools = toolSchemasForChannel('whatsapp', { purposeRequired: false });
    const today = promptHash(buildSystemPrompt({ brand: 'SmartRemit' }), tools);
    expect(promptHash(SYSTEM_PROMPT, tools)).toBe(today);
    expect(promptHash(buildSystemPrompt({ brand: 'SmartRemit', englishTransactionSteps: false }), tools)).toBe(today);
    expect(promptHash(buildSystemPrompt({ brand: 'SmartRemit', englishTransactionSteps: true }), tools)).not.toBe(today);
  });
});
