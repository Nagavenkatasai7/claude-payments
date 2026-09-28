import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/app/tailwind.css', 'utf8');
const landing = readFileSync('src/app/page.tsx', 'utf8');

/** All `--name: value;` declarations inside the FIRST block that starts with `selector {`. */
function block(selector: string, from = 0): Map<string, string> {
  const start = css.indexOf(`${selector} {`, from);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

// Frozen copy of tailwind.css:158-209 @ 96c8933. The demo depends on these values.
const FROZEN_ROOT: Record<string, string> = {
  '--background': '#f9f9fb', '--foreground': '#1c2024', '--card': '#ffffff', '--card-foreground': '#1c2024',
  '--popover': '#ffffff', '--popover-foreground': '#1c2024', '--primary': '#533afd', '--primary-foreground': '#ffffff',
  '--secondary': '#f0f0f3', '--secondary-foreground': '#1c2024', '--muted': '#f0f0f3', '--muted-foreground': '#60646c',
  '--accent': '#efeefe', '--accent-foreground': '#2e2b8c', '--destructive': '#ce2c31', '--destructive-foreground': '#ffffff',
  '--success': '#1a7049', '--warning': '#ab6400', '--border': '#e6e8ec', '--input': '#cdced6', '--ring': '#533afd',
  '--radius': '0.5rem', '--sidebar': '#fcfcfd', '--sidebar-foreground': '#1c2024', '--sidebar-primary': '#533afd',
  '--sidebar-primary-foreground': '#ffffff', '--sidebar-accent': '#efeefe', '--sidebar-accent-foreground': '#2e2b8c',
  '--sidebar-border': '#e6e8ec', '--sidebar-ring': '#533afd',
};
const FROZEN_ACCOUNT_BRAND: Record<string, string> = {
  '--primary': '#0c5bd2', '--primary-foreground': '#ffffff', '--ring': '#0c5bd2',
  '--accent': '#eef4fc', '--accent-foreground': '#0b1b3f', '--muted': '#f5f9ff',
};

describe('existing tokens are frozen (additive-only before Oct 6)', () => {
  it(':root keeps every pre-M1 value', () => {
    const root = block(':root');
    for (const [k, v] of Object.entries(FROZEN_ROOT)) expect(root.get(k), k).toBe(v);
  });
  it('.account-brand keeps every pre-M1 value', () => {
    const acc = block('.account-brand');
    for (const [k, v] of Object.entries(FROZEN_ACCOUNT_BRAND)) expect(acc.get(k), k).toBe(v);
  });
  it('no pre-M1 variable name is redeclared anywhere after the M1 marker', () => {
    const tail = css.slice(css.indexOf('/* ── DS tokens (UI redesign M1)'));
    for (const k of Object.keys(FROZEN_ROOT)) expect(tail).not.toMatch(new RegExp(`\\s${k}:`));
  });
});

// Extraction pin: each token equals a literal the landing still uses. If the landing drifts, this fails.
const EXTRACTED: Array<[token: string, value: string, landingNeedle: string]> = [
  ['--ds-brand-blue', '#0c5bd2', 'bg-[#0c5bd2] px-7 text-[15px] font-bold text-white'],
  ['--ds-brand-blue-hover', '#0a4fb8', 'hover:bg-[#0a4fb8]'],
  ['--ds-brand-teal', '#0e7490', 'linear-gradient(95deg,#0e7490,#0d9488_45%,#059669)'],
  ['--ds-brand-sky', '#48b3f5', 'linear-gradient(90deg,#0c5bd2,#48b3f5,#34d399)'],
  ['--ds-brand-mint', '#34d399', 'linear-gradient(90deg,#0c5bd2,#48b3f5,#34d399)'],
  ['--ds-ink', '#0b1b3f', 'text-[#0b1b3f] antialiased'],
  ['--ds-ink-muted', '#475569', 'leading-relaxed text-[#475569]'],
  ['--ds-ink-subtle', '#667085', 'placeholder:text-[#667085]'],
  ['--ds-ink-faint', '#52607a', 'leading-relaxed text-[#52607a]'],
  ['--ds-nav-bg', 'rgba(245,249,255,0.85)', 'bg-[rgba(245,249,255,0.85)] backdrop-blur-[12px]'],
  ['--ds-ground', '#f5f9ff', 'bg-[#f5f9ff] leading-[1.6]'],
  ['--ds-tint', '#eef4fc', 'hover:bg-[#eef4fc]'],
  ['--ds-border', '#dbe4f0', 'rounded-2xl border border-[#dbe4f0] bg-white'],
  ['--ds-border-strong', '#c5d3e6', 'border border-[#c5d3e6] bg-white/70'],
  ['--ds-border-input', '#8391a8', 'rounded-xl border border-[#8391a8] bg-white'],
  ['--ds-cta-whatsapp', '#25d366', 'rounded-full bg-[#25d366] px-7'],
  ['--ds-cta-whatsapp-hover', '#1fbd5d', 'hover:bg-[#1fbd5d]'],
  ['--ds-on-whatsapp', '#04231a', 'text-[#04231a]'],
  ['--ds-icon-bg', '#e3f6ee', 'bg-[#e3f6ee] text-[#047857] ring-1 ring-[#bfe8d3]'],
  ['--ds-success-bg', '#e8f7ef', 'border-[#a7e3c6] bg-[#e8f7ef]'],
  ['--ds-danger-bg', '#fdecec', 'border-[#f5c2c2] bg-[#fdecec]'],
];

describe('--ds-* tokens are extracted from the landing', () => {
  const ds = block(':root', css.indexOf('/* ── DS tokens (UI redesign M1)'));
  it.each(EXTRACTED)('%s = %s and the landing still uses it', (token, value, needle) => {
    expect(ds.get(token)).toBe(value);
    expect(landing).toContain(needle);
  });
  it('the overridable layer defaults to the landing brand', () => {
    expect(ds.get('--ds-primary')).toBe('var(--ds-brand-blue)');
    expect(ds.get('--ds-primary-hover')).toBe('var(--ds-brand-blue-hover)');
    expect(ds.get('--ds-accent')).toBe('var(--ds-brand-teal)');
  });
  it('every declaration that references an overridable token is ALSO declared on .ds-site (recomputes in a partner scope)', () => {
    const tail = css.slice(css.indexOf('/* ── DS tokens (UI redesign M1)'));
    const offenders: string[] = [];
    for (const m of tail.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (selector.startsWith('@theme')) continue; // @theme inline is inlined into utilities, not inherited
      for (const d of m[2].matchAll(/(--ds-[\w-]+):\s*([^;]+);/g)) {
        if (/var\(--ds-(primary|accent)\b/.test(d[2]) && !selector.split(',').map((x) => x.trim()).includes('.ds-site')) offenders.push(`${selector} ${d[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    const derived = block(':root,\n.ds-site');
    expect(derived.get('--ds-focus-ring')).toBe('var(--ds-primary)');
    expect(derived.get('--ds-shadow-primary')).toBe('0 10px 26px -12px color-mix(in srgb,var(--ds-primary) 70%,transparent)');
    expect(derived.get('--ds-gradient-bar')).toBe('linear-gradient(90deg,var(--ds-primary),var(--ds-brand-sky),var(--ds-brand-mint))');
  });
  it('type scale, radii and shadows match the landing recipes', () => {
    expect(ds.get('--ds-text-hero')).toBe('clamp(40px,6.2vw,74px)');
    expect(landing).toContain('text-[clamp(40px,6.2vw,74px)] font-extrabold leading-[1.03] tracking-[-0.038em]');
    expect(ds.get('--ds-text-h2')).toBe('clamp(28px,4vw,46px)');
    expect(ds.get('--ds-text-h3')).toBe('clamp(24px,3.2vw,38px)');
    expect(ds.get('--ds-shadow-cta')).toBe('0 10px 30px -10px rgba(37,211,102,0.65)');
    expect(ds.get('--ds-shadow-pop')).toBe('0 24px 60px -24px rgba(11,27,63,0.28)');
    expect(ds.get('--ds-radius-card')).toBe('1rem');
    expect(ds.get('--ds-container')).toBe('1180px');
  });
  it('src/lib/ui/tokens.ts mirrors the CSS values it needs', async () => {
    const t = await import('@/lib/ui/tokens');
    expect(ds.get('--ds-brand-blue')).toBe(t.DEFAULT_THEME.primary);
    expect(ds.get('--ds-brand-teal')).toBe(t.DEFAULT_THEME.accent);
    expect(ds.get('--ds-on-primary')).toBe(t.CONTRAST_REFERENCES.onPrimary);
    expect(ds.get('--ds-ground')).toBe(t.CONTRAST_REFERENCES.ground);
    for (const name of t.OVERRIDABLE_TOKENS) expect(ds.has(name), name).toBe(true);
  });
  it('@theme exposes ds utilities without touching existing theme keys', () => {
    const theme = css.slice(css.lastIndexOf('@theme inline {'));
    expect(theme).toContain('--color-ds-primary: var(--ds-primary);');
    expect(theme).toContain('--radius-ds-card: var(--ds-radius-card);');
    expect(theme).toContain('--shadow-ds-primary: var(--ds-shadow-primary);');
    expect(theme).not.toMatch(/--font-sans:|--color-primary:|--radius-lg:/);
  });
  it('.ds-site is a box-less scope (like .account-brand)', () => {
    expect(css).toMatch(/\.ds-site\s*\{\s*display:\s*contents;\s*\}/);
  });
});

describe('gradient utilities (Tailwind v4 @utility)', () => {
  it('bg-ds-gradient-bar and bg-ds-gradient-text read the tokens', () => {
    expect(css).toMatch(/@utility bg-ds-gradient-bar \{\s*background-image: var\(--ds-gradient-bar\);\s*\}/);
    expect(css).toMatch(/@utility bg-ds-gradient-text \{\s*background-image: var\(--ds-gradient-text\);\s*\}/);
  });
  it('--ds-gradient-text is the landing "made simpler." gradient', () => {
    const ds = block(':root', css.indexOf('/* ── DS tokens (UI redesign M1)'));
    expect(ds.get('--ds-gradient-text')).toBe('linear-gradient(95deg,#0e7490,#0d9488 45%,#059669)');
    expect(landing).toContain('bg-[linear-gradient(95deg,#0e7490,#0d9488_45%,#059669)]');
  });
});
