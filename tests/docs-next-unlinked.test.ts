import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SPEC §7 / M4 "Unlinked": /docs-next and /trust are built before the demo but nothing
// reachable today may link them until the post-demo swap (PR-7 removes this guard's
// allowlist entries deliberately). The scan is broad (all of src/ and public/, plus the
// public-repo files a reader lands on) with an explicit allowlist of places that are
// themselves only reachable from inside those two surfaces.

const walk = (d: string): string[] =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

const TEXT = /\.(tsx?|jsx?|mjs|css|mdx?|json|ya?ml|html|txt|xml|svg|webmanifest)$/;
// Only reachable from inside /docs-next or /trust (or the scanner registry itself).
const ALLOW = ['src/app/docs-next/', 'src/app/trust/', 'src/content/', 'src/components/docs/', 'src/lib/ui/new-ui-roots.ts'];
// A link-shaped path: a quote, backtick, paren, '=' or whitespace, then /docs-next or /trust as a whole segment;
// or an absolute URL ending in one. Prose like "brand/trust" does not match.
const LINK = /(?:^|[\s"'`(=])\/(?:docs-next|trust)(?=[/?#"'`)\s]|$)|https?:\/\/[^\s"'`)]*\/(?:docs-next|trust)(?=[/?#"'`)\s]|$)/m;

function linkHits(files: string[]): string[] {
  return files.filter((f) => LINK.test(readFileSync(f, 'utf8')));
}

describe('/docs-next and /trust stay unlinked until the post-demo swap (SPEC §7)', () => {
  it('the link matcher catches hrefs and absolute URLs but not prose', () => {
    for (const s of ['href="/docs-next"', "href='/trust'", 'href={`/docs-next/${slug}`}', 'see (/trust)', 'https://smartremit.ai/trust', 'redirect("/docs-next/api")'])
      expect({ s, hit: LINK.test(s) }).toEqual({ s, hit: true });
    for (const s of ['no brand/trust yet', 'href="/docs"', 'href="/trusted"', 'href="/docs-nextgen"', 'trustProxy'])
      expect({ s, hit: LINK.test(s) }).toEqual({ s, hit: false });
  });

  it('no reachable source (src, public, README, SECURITY.md, openapi.yaml) links them', () => {
    const files = [...walk('src'), ...walk('public'), 'README.md', 'SECURITY.md', 'openapi.yaml']
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => existsSync(f) && TEXT.test(f) && !ALLOW.some((a) => f.startsWith(a)));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/app/page.tsx');
    expect(files).toContain('src/app/sitemap.ts');
    expect(files).toContain('src/components/site/SiteHeader.tsx');
    expect(linkHits(files)).toEqual([]);
  });

  it('the docs-next and trust layouts set noindex, and no child file overrides robots', () => {
    for (const layout of ['src/app/docs-next/layout.tsx', 'src/app/trust/layout.tsx']) {
      if (!existsSync(layout)) continue; // the routes land in PR-3 / PR-6
      expect(readFileSync(layout, 'utf8')).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false/);
    }
    for (const dir of ['src/app/docs-next', 'src/app/trust'])
      for (const f of walk(dir).filter((x) => !x.endsWith('layout.tsx')))
        expect({ f, robots: /\brobots\s*:/.test(readFileSync(f, 'utf8')) }).toEqual({ f, robots: false });
  });
});
