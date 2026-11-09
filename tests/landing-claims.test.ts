import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APPROVED_PUBLIC_PHRASINGS, findPublicClaims } from '@/lib/claims-register';

// Program-Fix 14 PR B (docs-01): the landing page claimed sanctions screening
// with no qualifier, while the demo screens against a built-in reference list
// (src/lib/compliance-config.ts), not a production sanctions feed. Every
// sanctions claim on the landing page now carries the demo qualifier, and the
// /docs 422 claim carries the same caveat as /about ("Sanctions screening
// always on"). Static grep over the page sources, like landing-corridors.test.ts.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');
const LANDING = read('src/app/page.tsx');
const DOCS = read('src/content/docs/getting-started.mdx');
const SHOWCASE = read('src/app/landing/showcase.tsx');

const squash = (s: string) => s.replace(/\s+/g, ' ');
const QUALIFIER = /reference (list|rule set)/i;

describe('landing sanctions claims are qualified (Program-Fix 14, docs-01)', () => {
  it('no unqualified "Sanctions screening on every transfer" badge or "sanctions-screened" meta remains', () => {
    expect(LANDING).not.toMatch(/sanctions screening on every transfer/i);
    expect(LANDING).not.toMatch(/sanctions-screened/i);
    expect(squash(LANDING)).not.toMatch(/signed, screened/i);
  });

  it('every sanctions-screening claim on the landing page is followed by the demo qualifier', () => {
    const text = squash(LANDING);
    const hits = [...text.matchAll(/sanctions[\s-]+screen/gi)];
    expect(hits.length).toBeGreaterThanOrEqual(3);
    for (const m of hits) {
      const window = text.slice(m.index!, m.index! + 260);
      expect(window, `unqualified claim: "${window.slice(0, 120)}"`).toMatch(QUALIFIER);
    }
  });

  it('the landing badge is qualified, not deleted', () => {
    expect(LANDING).toContain('<ShieldIcon /> Sanctions screening runs on every transfer (demo: reference list)');
  });

  it('the docs 422 claim (getting-started guide) carries the /about caveat', () => {
    const text = squash(DOCS);
    const at = text.indexOf('Compliance screening (sanctions) runs on');
    expect(at).toBeGreaterThan(-1);
    const para = text.slice(at, at + 420);
    expect(para).toMatch(/watchlist hit returns `?422`?/);
    expect(para).toMatch(/built-in reference rule set, not yet a live commercial AML feed/);
  });

  it('the AI-layer mock on / (showcase.tsx) qualifies its sanctions claims, visible text and aria-label', () => {
    expect(SHOWCASE).toContain('Sanctions screening — always on (demo: reference list)');
    const aria = SHOWCASE.match(/aria-label="SmartRemit's AI layer:[^"]*"/);
    expect(aria, 'AiMock aria-label not found').not.toBeNull();
    expect(aria![0]).toMatch(/sanctions screening always on \(demo: reference list\)/);
    const text = squash(SHOWCASE);
    const hits = [...text.matchAll(/sanctions[\s-]+screen/gi)];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const m of hits) {
      const window = text.slice(m.index!, m.index! + 260);
      expect(window, `unqualified claim: "${window.slice(0, 120)}"`).toMatch(QUALIFIER);
    }
  });
});

// R20: the public pages say only what SmartRemit can stand behind. Every public
// page source is scanned against the claims register (src/lib/claims-register.ts):
// no instant or in-minutes delivery, no unqualified encryption, audit or safety
// claim, no "under their own brand", no Telegram "available now", nothing that
// makes SmartRemit the licensed sender of the money, and (home page only, Q11)
// no named AI app. src/lib/prompt.ts is not scanned: its rules quote banned
// phrases in order to forbid them.
describe('public pages carry no banned claim (R20 claims register)', () => {
  const walk = (d: string): string[] =>
    readdirSync(resolve(process.cwd(), d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : /\.(tsx?|mdx)$/.test(e.name) ? [join(d, e.name)] : [],
    );
  const HOME = ['src/app/page.tsx', ...walk('src/app/landing')];
  const SITE = [...walk('src/app/about'), ...walk('src/content'), ...walk('src/lib/legal')];

  it('scans the home page, the about page, the docs and trust content, and the legal drafts', () => {
    expect(HOME).toContain('src/app/landing/channels.ts');
    expect(HOME).toContain('src/app/landing/HeroPipeline.tsx');
    expect(SITE).toContain('src/app/about/page.tsx');
    expect(SITE).toContain('src/content/docs/ai-apps.mdx');
    expect(SITE).toContain('src/lib/legal/drafts.ts');
  });

  for (const f of HOME) {
    it(`${f} (home scope) makes no banned claim`, () => {
      expect({ f, hits: findPublicClaims(read(f), 'home') }).toEqual({ f, hits: [] });
    });
  }
  for (const f of SITE) {
    it(`${f} makes no banned claim`, () => {
      expect({ f, hits: findPublicClaims(read(f), 'site') }).toEqual({ f, hits: [] });
    });
  }

  it('the home page and the about page say who provides the transfer, in the approved words', () => {
    const provider = APPROVED_PUBLIC_PHRASINGS.find((p) => p.topic === 'provider')!.say;
    expect(squash(LANDING)).toContain(provider);
    expect(squash(read('src/app/about/page.tsx'))).toContain(provider);
  });

  it('the AI-apps guide intro is generic: no app named, no endorsement, invitation only', () => {
    const guide = read('src/content/docs/ai-apps.mdx');
    const intro = squash(guide.slice(0, guide.indexOf('## Before you start')));
    expect(intro).not.toMatch(/\b(Claude|ChatGPT|Perplexity|Gemini|Copilot)\b/);
    expect(intro).toContain('an AI app that supports custom MCP connectors');
    expect(intro).toContain("SmartRemit is not listed in any app's public connector directory and is not affiliated with or endorsed by any AI app maker.");
    expect(intro).toMatch(/invite-only early access/);
    // The cited connector steps stay (tests/docs-content-guard.test.ts allows their hosts).
    expect(guide).toContain('## Connect from Claude');
  });

  it('the home h1 the production smoke checks is unchanged (tests/e2e/dashboard-smoke.spec.ts)', () => {
    const h1 = squash(LANDING).match(/<h1 id="hero-h"[^>]*>([\s\S]*?)<\/h1>/);
    expect(h1).not.toBeNull();
    expect(h1![1]).toMatch(/^ Send money home\{' '\} .*from the chat apps you already use\. <\/span> $/);
  });
});
