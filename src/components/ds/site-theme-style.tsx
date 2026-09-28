import { validateThemeColor } from '@/lib/ui/theme';

/**
 * The partner theme as a scoped <style>: re-points ONLY the overridable tokens inside `.ds-site`.
 *
 * Trusts nothing about its input: each value is re-validated here (strict six-digit hex, contrast
 * rule), and the CSS is assembled only from those validated lowercase values plus fixed text, so
 * no stored string ever reaches the output. The text gradient is built from the two validated
 * colours, never read from anywhere. An invalid colour is omitted (the default token applies);
 * with neither valid, nothing is rendered. The hover shade is derived, not separately validated.
 * The logo never goes here (see SiteBrand).
 */
export function SiteThemeStyle({ theme }: { theme: { primary: unknown; accent: unknown } }) {
  const p = validateThemeColor(theme.primary);
  const a = validateThemeColor(theme.accent);
  const decls: string[] = [];
  if (p.ok) decls.push(`--ds-primary:${p.value}`, `--ds-primary-hover:color-mix(in srgb,${p.value} 88%,black)`);
  if (a.ok) decls.push(`--ds-accent:${a.value}`);
  if (p.ok && a.ok) decls.push(`--ds-gradient-text:linear-gradient(95deg,${p.value},${a.value})`);
  if (decls.length === 0) return null;
  const css = `.ds-site{${decls.join(';')}}`;
  return <style>{css}</style>;
}
