import { describe, it, expect } from 'vitest';
import { dsCn, DS_COLORS } from '@/lib/ui/ds-cn';

describe('dsCn', () => {
  it('keeps a ds colour and an arbitrary font size together', () => {
    expect(dsCn('text-[15px]', 'text-ds-ink')).toBe('text-[15px] text-ds-ink');
  });
  it('a later ds colour overrides an earlier ds colour', () => {
    expect(dsCn('bg-ds-primary', 'bg-ds-cta-whatsapp')).toBe('bg-ds-cta-whatsapp');
  });
  it('ds radius and shadow merge in their own groups', () => {
    expect(dsCn('rounded-ds-card', 'rounded-full')).toBe('rounded-full');
    expect(dsCn('shadow-ds-cta', 'shadow-ds-primary')).toBe('shadow-ds-primary');
  });
  it('a ds shadow and a stock shadow override each other; a shadow colour is its own group', () => {
    expect(dsCn('shadow-ds-primary', 'shadow-lg')).toBe('shadow-lg');
    expect(dsCn('shadow-lg', 'shadow-ds-primary')).toBe('shadow-ds-primary');
    expect(dsCn('shadow-ds-pop', 'shadow-ds-cta-whatsapp')).toBe('shadow-ds-pop shadow-ds-cta-whatsapp');
  });
  it('every ds colour token in tailwind.css is known to dsCn', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/app/tailwind.css', 'utf8');
    const tokens = [...css.matchAll(/--color-(ds-[\w-]+):/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0);
    expect([...DS_COLORS].sort()).toEqual([...tokens].sort());
    for (const tok of tokens) expect(dsCn('text-[15px]', `text-${tok}`), tok).toBe(`text-[15px] text-${tok}`);
  });
});
