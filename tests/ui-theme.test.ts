import { describe, it, expect } from 'vitest';
import { normalizeHex, contrastRatio, validateThemeColor, resolveSiteTheme } from '@/lib/ui/theme';
import { DEFAULT_THEME, CONTRAST_REFERENCES } from '@/lib/ui/tokens';

describe('normalizeHex', () => {
  it.each([['#0C5BD2', '#0c5bd2'], ['#0c5bd2', '#0c5bd2'], [' #0c5bd2 ', null], ['#fff', null], ['0c5bd2', null],
    ['red', null], ['#0c5bd2;}', null], ['</style>', null], [42, null], [null, null], ['#0c5bd2\n', null],
    ['#0c5bd2ff', null], [undefined, null], [{ toString: () => '#0c5bd2' }, null]])('%j → %j', (i, o) =>
    expect(normalizeHex(i)).toBe(o));
});
describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#0c5bd2', '#ffffff')).toBeCloseTo(6.1, 1);
    expect(contrastRatio('#0e7490', '#f5f9ff')).toBeCloseTo(5.07, 1);
  });
  it('is symmetric', () => {
    expect(contrastRatio('#ffffff', '#0c5bd2')).toBeCloseTo(contrastRatio('#0c5bd2', '#ffffff'), 6);
  });
});
describe('validateThemeColor (SPEC §1.4; pairs: vs --ds-on-primary #ffffff AND vs --ds-ground #f5f9ff)', () => {
  it('the defaults pass their own rule against BOTH references', () => {
    expect(validateThemeColor(DEFAULT_THEME.primary)).toEqual({ ok: true, value: DEFAULT_THEME.primary });
    expect(validateThemeColor(DEFAULT_THEME.accent)).toEqual({ ok: true, value: DEFAULT_THEME.accent });
    for (const c of [DEFAULT_THEME.primary, DEFAULT_THEME.accent])
      for (const r of [CONTRAST_REFERENCES.onPrimary, CONTRAST_REFERENCES.ground]) expect(contrastRatio(c, r)).toBeGreaterThanOrEqual(4.5);
  });
  it('rejects low contrast: WhatsApp green (1.98:1) and the landing teal stops 3.5/3.6', () => {
    for (const c of ['#25d366', '#0d9488', '#059669', '#ffff00', '#ffffff']) expect(validateThemeColor(c)).toEqual({ ok: false, reason: 'contrast' });
  });
  it('a colour that passes vs white but fails vs the ground is still rejected (both pairs are checked)', () => {
    // #767676 is ~4.54:1 on white but below 4.5:1 on the ground.
    expect(contrastRatio('#767676', CONTRAST_REFERENCES.onPrimary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#767676', CONTRAST_REFERENCES.ground)).toBeLessThan(4.5);
    expect(validateThemeColor('#767676')).toEqual({ ok: false, reason: 'contrast' });
  });
  it('uppercase input is normalised to lowercase (the DB CHECK is lowercase-only)', () => {
    expect(validateThemeColor('#0E7490')).toEqual({ ok: true, value: '#0e7490' });
  });
  it('rejects bad format', () => {
    for (const c of ['#fff', 'blue', 'rgb(0,0,0)', 'var(--x)', '#0c5bd2;}body{display:none}', 'url(x)', '</style><script>', '', null, 7])
      expect(validateThemeColor(c)).toEqual({ ok: false, reason: 'format' });
  });
});
describe('resolveSiteTheme (render-time re-validation)', () => {
  it('falls back per colour to the defaults for anything invalid', () => {
    expect(resolveSiteTheme({ primaryColor: '#25D366', accentColor: 'red;}' })).toEqual({
      primary: DEFAULT_THEME.primary, accent: DEFAULT_THEME.accent, primaryFromPartner: false, accentFromPartner: false });
    expect(resolveSiteTheme({ primaryColor: '#7A1FA2' })).toMatchObject({ primary: '#7a1fa2', primaryFromPartner: true, accent: DEFAULT_THEME.accent, accentFromPartner: false });
    expect(resolveSiteTheme({})).toEqual({ primary: DEFAULT_THEME.primary, accent: DEFAULT_THEME.accent, primaryFromPartner: false, accentFromPartner: false });
  });
});
