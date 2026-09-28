// Partner theme colours (SPEC §1.4). Pure. Every partner colour is re-validated here at RENDER
// time as well as on write: partners.primary_color is only trimmed by the legacy save path, so a
// stored value is never trusted. A value is accepted only as a strict #rrggbb (returned
// lowercase, matching the partner_sites CHECK) that reaches MIN_CONTRAST against BOTH
// CONTRAST_REFERENCES (the on-primary text colour and the page ground).
import { CONTRAST_REFERENCES, DEFAULT_THEME, MIN_CONTRAST } from './tokens';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** `#RRGGBB` (any case) → lowercase; anything else (incl. whitespace, short hex, non-strings) → null. */
export function normalizeHex(raw: unknown): string | null {
  return typeof raw === 'string' && HEX6.test(raw) ? raw.toLowerCase() : null;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export type ThemeColorResult = { ok: true; value: string } | { ok: false; reason: 'format' | 'contrast' };

export function validateThemeColor(raw: unknown): ThemeColorResult {
  const v = normalizeHex(raw);
  if (!v) return { ok: false, reason: 'format' };
  const refs = [CONTRAST_REFERENCES.onPrimary, CONTRAST_REFERENCES.ground];
  return refs.every((r) => contrastRatio(v, r) >= MIN_CONTRAST) ? { ok: true, value: v } : { ok: false, reason: 'contrast' };
}

export interface SiteTheme {
  primary: string;
  accent: string;
  primaryFromPartner: boolean;
  accentFromPartner: boolean;
}

/** Per colour: the partner's value if it validates, else DEFAULT_THEME. */
export function resolveSiteTheme(input: { primaryColor?: unknown; accentColor?: unknown }): SiteTheme {
  const p = validateThemeColor(input.primaryColor);
  const a = validateThemeColor(input.accentColor);
  return {
    primary: p.ok ? p.value : DEFAULT_THEME.primary,
    accent: a.ok ? a.value : DEFAULT_THEME.accent,
    primaryFromPartner: p.ok,
    accentFromPartner: a.ok,
  };
}
