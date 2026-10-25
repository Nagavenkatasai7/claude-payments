import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sitemap from '@/app/sitemap';
import { FOOTER_COLUMNS } from '@/components/site/site-links';

// /trust was an unlinked, noindex preview (SPEC §7). Owner go 2026-10-25 (Raj's website brief):
// it is now public. The landing footer, the site-shell footer and the About page link it as
// "Security & compliance", the sitemap lists it, and no file under src/app/trust sets robots.

const walk = (d: string): string[] =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('/trust is public and linked (owner go 2026-10-25)', () => {
  it('the landing footer, the site-shell footer and the About page link it', () => {
    const landing = readFileSync('src/app/page.tsx', 'utf8');
    const footer = landing.slice(landing.indexOf('<footer'), landing.indexOf('</footer>'));
    expect(footer).toMatch(/href="\/trust"[^>]*>\s*Security &amp; compliance/);
    expect(FOOTER_COLUMNS.flatMap((c) => c.links)).toContainEqual({ href: '/trust', label: 'Security & compliance' });
    expect(readFileSync('src/app/about/page.tsx', 'utf8')).toMatch(/href="\/trust"/);
  });

  it('the sitemap lists it', () => {
    expect(sitemap().map((e) => e.url)).toContain('https://smartremit.ai/trust');
  });

  it('no file under src/app/trust sets robots (the page is indexable)', () => {
    for (const f of walk('src/app/trust')) expect({ f, robots: /\brobots\s*:/.test(readFileSync(f, 'utf8')) }).toEqual({ f, robots: false });
  });

  it('the docs are public: no file under src/app/docs sets robots, and the old preview folder is gone', () => {
    for (const f of walk('src/app/docs')) expect({ f, robots: /\brobots\s*:/.test(readFileSync(f, 'utf8')) }).toEqual({ f, robots: false });
    expect(existsSync('src/app/docs-next')).toBe(false);
  });
});
