import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteThemeStyle } from '@/components/ds/site-theme-style';
import { SiteBrand } from '@/components/ds/site-brand';

const render = (primary: unknown, accent: unknown) => renderToStaticMarkup(createElement(SiteThemeStyle, { theme: { primary, accent } }));

// Hostile or invalid colour strings: CSS breakout, HTML breakout, url(), short hex, low contrast,
// legacy IE expression(), !important smuggling, non-strings dressed up as a colour.
const HOSTILE: unknown[] = [
  'red;}body{display:none}', '</style><script>alert(1)</script>', '#fff', 'url(javascript:alert(1))',
  '#25d366' /* fails contrast */, 'expression(alert(1))', '#0c5bd2 !important', { toString: () => '#7a1fa2' },
  '#7a1fa2;', '#7a1fa2}', '#7a1fa2<', ' #7a1fa2', '#7a1fa2\n', 'url(#7a1fa2)', 'var(--ds-ink)',
  'linear-gradient(95deg,#7a1fa2,#0e7490)', '#7a1fa2/**/', '', null, undefined, 42, ['#7a1fa2'],
];

describe('SiteThemeStyle emits ONLY validated custom properties', () => {
  it('a valid partner theme', () => {
    expect(render('#7A1FA2', '#0E7490')).toBe(
      '<style>.ds-site{--ds-primary:#7a1fa2;--ds-primary-hover:color-mix(in srgb,#7a1fa2 88%,black);--ds-accent:#0e7490;--ds-gradient-text:linear-gradient(95deg,#7a1fa2,#0e7490)}</style>');
  });
  it.each(HOSTILE)('hostile/invalid primary %j is dropped, nothing raw is emitted', (bad) => {
    expect(render(bad, 'nope')).toBe('');
  });
  it.each(HOSTILE)('hostile/invalid accent %j is dropped, nothing raw is emitted', (bad) => {
    expect(render('nope', bad)).toBe('');
  });
  it.each(HOSTILE)('hostile %j next to a valid colour emits only the valid colour', (bad) => {
    const p = render('#7a1fa2', bad);
    expect(p).toBe('<style>.ds-site{--ds-primary:#7a1fa2;--ds-primary-hover:color-mix(in srgb,#7a1fa2 88%,black)}</style>');
    const a = render(bad, '#0e7490');
    expect(a).toBe('<style>.ds-site{--ds-accent:#0e7490}</style>');
  });
  it('one valid colour emits only that colour’s properties (no gradient from a single colour)', () => {
    const html = render('#7a1fa2', 'x');
    expect(html).toContain('--ds-primary:#7a1fa2');
    expect(html).not.toContain('--ds-accent');
    expect(html).not.toContain('--ds-gradient-text');
  });
  it('the output only ever contains [a-z0-9#-,(.%) ;:{}] characters', () => {
    expect(render('#7a1fa2', '#0e7490')).toMatch(/^<style>[a-z0-9#\-,(.%) ;:{}]+<\/style>$/);
    expect(render('#7A1FA2', '#0E7490')).toMatch(/^<style>[a-z0-9#\-,(.%) ;:{}]+<\/style>$/);
  });
  it('every pair of hostile values emits nothing at all', () => {
    for (const p of HOSTILE) for (const a of HOSTILE) {
      const html = render(p, a);
      expect(html).toBe('');
    }
  });
});

describe('SiteBrand', () => {
  it('renders a legacy svg data URI only as <img src>, never in a style', () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
    const html = renderToStaticMarkup(createElement(SiteBrand, { brand: 'Acme Remit', logo: svg }));
    expect(html).toMatch(/^<img [^>]*src="data:image\/svg\+xml;base64,[^"]+"[^>]*alt="Acme Remit"/);
    expect(html).not.toContain('<style');
    expect(html).not.toContain('url(');
    expect(html).not.toContain('style=');
  });
  it('renders a legacy https logo as <img src> (plus only React’s own image preload hint for the same URL)', () => {
    // React 19 emits <link rel="preload" as="image"> for a non-data: <img src> (react-dom-server,
    // case "img"); in a full document it is hoisted into <head>. It carries the same sanitised URL.
    const html = renderToStaticMarkup(createElement(SiteBrand, { brand: 'Acme', logo: 'https://cdn.example/l.png' }));
    expect(html).toMatch(/^(<link rel="preload" as="image" href="https:\/\/cdn\.example\/l\.png"\/>)?<img [^>]*src="https:\/\/cdn\.example\/l\.png"[^>]*alt="Acme"[^>]*\/>$/);
    expect(html).not.toContain('<style');
  });
  it('falls back to the brand name for junk', () => {
    for (const logo of ['javascript:1', 'data:text/html;base64,PHNjcmlwdD4=', 'http://x.example/l.png', '', null, 5]) {
      const html = renderToStaticMarkup(createElement(SiteBrand, { brand: 'Acme', logo }));
      expect(html).toContain('>Acme<');
      expect(html).not.toContain('<img');
    }
  });
  it('escapes the brand name (text and alt)', () => {
    const t = renderToStaticMarkup(createElement(SiteBrand, { brand: '<script>x</script>', logo: null }));
    expect(t).not.toContain('<script>');
    const i = renderToStaticMarkup(createElement(SiteBrand, { brand: '"><script>', logo: 'https://cdn.example/l.png' }));
    expect(i).not.toContain('"><script>');
  });
});
