import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SPEC §8a cookie check: a cookie scoped to a parent domain (Domain=.smartremit.ai) would be sent to
// EVERY partner subdomain, so partner A's host could read partner B's (or the platform's) session.
// Every cookie stays host-only: no source may set a `domain` option or a Domain= attribute.

function walk(d: string, out: string[] = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js)$/.test(n)) out.push(p);
  }
  return out;
}
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const DOMAIN_KEY = /\bdomain\s*:|\bdomain\s*=/i;

// Non-cookie `domain:` / `domain =` uses, each with a reason. The reviewer checks every entry.
const DOMAIN_KEY_EXEMPT: ReadonlyArray<[file: string, reason: string]> = [];

describe('no cookie is ever scoped to a parent domain (SPEC §8a cookie check)', () => {
  const files = walk('src').map((f) => [f.replaceAll('\\', '/'), readFileSync(f, 'utf8')] as const);
  it('scans a real tree', () => expect(files.length).toBeGreaterThan(100));
  it('no source sets a `domain` cookie option or a Domain= attribute', () => {
    const offenders = files
      .filter(([f]) => !DOMAIN_KEY_EXEMPT.some(([e]) => f.endsWith(e)))
      .filter(([, s]) => DOMAIN_KEY.test(stripComments(s)))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
  it('every exemption still exists and still needs exempting (no stale entries)', () => {
    for (const [e] of DOMAIN_KEY_EXEMPT) {
      const hit = files.find(([f]) => f.endsWith(e));
      expect(hit, e).toBeDefined();
      expect(DOMAIN_KEY.test(stripComments(hit![1])), e).toBe(true);
    }
  });
  it('no source mentions the parent cookie scope ".smartremit.ai"', () => {
    expect(files.filter(([, s]) => s.includes("'.smartremit.ai'") || s.includes('".smartremit.ai"') || s.includes('`.smartremit.ai`')).map(([f]) => f)).toEqual([]);
  });
  it('the scanner catches an offender (self-test), including a variable value', () => {
    expect(DOMAIN_KEY.test("jar.set('x','y',{ domain: '.smartremit.ai' })")).toBe(true);
    expect(DOMAIN_KEY.test("jar.set('x','y',{ domain: parentDomain })")).toBe(true);
    expect(DOMAIN_KEY.test("jar.set({ name: 'x', value: 'y', Domain: d })")).toBe(true);
    expect(DOMAIN_KEY.test("res.headers.append('set-cookie', `a=b; Domain=${d}`)")).toBe(true);
    expect(DOMAIN_KEY.test(stripComments('// domain: amountInr'))).toBe(false);
    expect(DOMAIN_KEY.test(stripComments('/* domain: x */ const a = 1;'))).toBe(false);
    expect(DOMAIN_KEY.test(stripComments("const u = 'https://x.y/z'; // domain: q"))).toBe(false);
  });
});
