import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Program-Fix 14 PR B (docs-01): the landing page claimed sanctions screening
// with no qualifier, while the demo screens against a built-in reference list
// (src/lib/compliance-config.ts), not a production sanctions feed. Every
// sanctions claim on the landing page now carries the demo qualifier, and the
// /docs 422 claim carries the same caveat as /about ("Sanctions screening
// always on"). Static grep over the page sources, like landing-corridors.test.ts.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');
const LANDING = read('src/app/page.tsx');
const DOCS = read('src/app/docs/page.tsx');
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

  it('the /docs 422 claim carries the /about caveat', () => {
    const text = squash(DOCS);
    const at = text.indexOf('Compliance screening (sanctions) runs on');
    expect(at).toBeGreaterThan(-1);
    const para = text.slice(at, at + 420);
    expect(para).toContain('watchlist hit returns 422');
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
