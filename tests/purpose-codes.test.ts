import { describe, it, expect } from 'vitest';
import { PURPOSE_HINTS, PURPOSE_LABELS, SUGGESTED_RBI_CODE, TRANSFER_PURPOSES, purposeView, suggestedRbiCode } from '@/lib/purpose-codes';
import { toolSchemasForChannel } from '@/lib/tools';

// Purpose detection (Raj #17): the RBI purpose code is a staff/partner-only
// SUGGESTION. Only family_support has one (P1301); the rest stay null until
// confirmed. Labels are English, hints feed the prompt.

const ALL = ['family_support', 'gift', 'education', 'medical', 'savings', 'bills', 'business', 'other'] as const;

describe('purpose codes', () => {
  it('TRANSFER_PURPOSES is the same set as the send_approve_picker purpose enum', () => {
    const picker = toolSchemasForChannel('whatsapp').find((t) => t.function.name === 'send_approve_picker')!;
    const props = (picker.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect([...TRANSFER_PURPOSES].sort()).toEqual([...(props.purpose.enum ?? [])].sort());
    expect([...TRANSFER_PURPOSES].sort()).toEqual([...ALL].sort());
  });

  it('every enum value has a code entry and an English label', () => {
    for (const p of ALL) {
      expect(Object.prototype.hasOwnProperty.call(SUGGESTED_RBI_CODE, p), p).toBe(true);
      expect(PURPOSE_LABELS[p], p).toMatch(/^[A-Z][a-z ]+$/);
    }
    expect(Object.keys(SUGGESTED_RBI_CODE).sort()).toEqual([...ALL].sort());
  });

  it('family_support suggests P1301; every other purpose and undefined suggest nothing', () => {
    expect(suggestedRbiCode('family_support')).toBe('P1301');
    for (const p of ALL.filter((x) => x !== 'family_support')) expect(suggestedRbiCode(p), p).toBeNull();
    expect(suggestedRbiCode(undefined)).toBeNull();
    expect(suggestedRbiCode()).toBeNull();
  });

  it('hints use only real enum values and carry the Hinglish examples', () => {
    for (const h of PURPOSE_HINTS) expect(ALL as readonly string[]).toContain(h.purpose);
    const said = (p: string) => PURPOSE_HINTS.filter((h) => h.purpose === p).flatMap((h) => h.examples);
    expect(said('family_support')).toEqual(expect.arrayContaining(['maa ki dawai', 'ghar ka kharcha', 'Mom ko monthly']));
    expect(said('education')).toContain('bhai ki fees');
    expect(said('medical')).toContain('hospital ka bill');
  });
});

describe('purposeView (staff and partner detail pages)', () => {
  it('absent purpose ⇒ null (no row)', () => {
    expect(purposeView(undefined)).toBeNull();
    expect(purposeView(null)).toBeNull();
  });
  it('a label, plus the suggested code only where one exists', () => {
    expect(purposeView('family_support')).toEqual({ label: 'Family support', suggestedCode: 'P1301' });
    expect(purposeView('education')).toEqual({ label: 'Education', suggestedCode: null });
  });
  it('an unknown stored value is no row (never echoed)', () => {
    expect(purposeView('<script>' as never)).toBeNull();
  });
});
