import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SPEC §7 / M4 "Unlinked": /trust is built before the demo but nothing reachable today may link
// it until the post-demo swap. The scan is broad (all of src/ and public/, plus the public-repo
// files a reader lands on) with an explicit allowlist of places only reachable from inside /trust.
// The docs left this guard when the /docs-next preview became the linked, indexed /docs (the
// last test pins that side).

const walk = (d: string): string[] =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

const TEXT = /\.(tsx?|jsx?|mjs|css|mdx?|json|ya?ml|html|txt|xml|svg|webmanifest)$/;
// Only reachable from inside /trust (its page, its content modules, or the scanner registry itself).
const ALLOW = ['src/app/trust/', 'src/content/trust/', 'src/lib/ui/new-ui-roots.ts'];
// A link-shaped path: a quote, backtick, paren, '=' or whitespace, then /trust as a whole segment;
// or an absolute URL ending in it. Prose like "brand/trust" does not match.
const LINK = /(?:^|[\s"'`(=])\/trust(?=[/?#"'`)\s]|$)|https?:\/\/[^\s"'`)]*\/trust(?=[/?#"'`)\s]|$)/m;

function linkHits(files: string[]): string[] {
  return files.filter((f) => LINK.test(readFileSync(f, 'utf8')));
}

describe('/trust stays unlinked until the post-demo swap (SPEC §7)', () => {
  it('the link matcher catches hrefs and absolute URLs but not prose', () => {
    for (const s of ["href='/trust'", 'href={`/trust/${x}`}', 'see (/trust)', 'https://smartremit.ai/trust', 'redirect("/trust")'])
      expect({ s, hit: LINK.test(s) }).toEqual({ s, hit: true });
    for (const s of ['no brand/trust yet', 'href="/docs"', 'href="/trusted"', 'trustProxy'])
      expect({ s, hit: LINK.test(s) }).toEqual({ s, hit: false });
  });

  it('no reachable source (src, public, README, SECURITY.md, openapi.yaml) links it', () => {
    const files = [...walk('src'), ...walk('public'), 'README.md', 'SECURITY.md', 'openapi.yaml']
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => existsSync(f) && TEXT.test(f) && !ALLOW.some((a) => f.startsWith(a)));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/app/page.tsx');
    expect(files).toContain('src/app/sitemap.ts');
    expect(files).toContain('src/components/site/SiteHeader.tsx');
    expect(files).toContain('src/content/docs/ai-apps.mdx');
    expect(linkHits(files)).toEqual([]);
  });

  it('the trust layout sets noindex, and no child file overrides robots', () => {
    expect(readFileSync('src/app/trust/layout.tsx', 'utf8')).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false/);
    for (const f of walk('src/app/trust').filter((x) => !x.endsWith('layout.tsx')))
      expect({ f, robots: /\brobots\s*:/.test(readFileSync(f, 'utf8')) }).toEqual({ f, robots: false });
  });

  it('the docs are public: no file under src/app/docs sets robots, and the old preview folder is gone', () => {
    for (const f of walk('src/app/docs')) expect({ f, robots: /\brobots\s*:/.test(readFileSync(f, 'utf8')) }).toEqual({ f, robots: false });
    expect(existsSync('src/app/docs-next')).toBe(false);
  });
});
