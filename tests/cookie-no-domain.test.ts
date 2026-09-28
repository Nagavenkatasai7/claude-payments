import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SPEC §8a cookie check: a cookie scoped to a parent domain (Domain=.smartremit.ai) would be sent to
// EVERY partner subdomain, so partner A's host could read partner B's (or the platform's) session.
// Every cookie stays host-only: no source may set a `domain` option or a Domain= attribute.

function walk(d: string, out: string[] = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js|json)$/.test(n)) out.push(p);
  }
  return out;
}
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// `domain:` / `domain =` / `Domain=` (bare, quoted or backticked key), or the shorthand `{ domain }` / `, domain,`.
const DOMAIN_KEY = /(?:^|[^\w$])['"`]?domain['"`]?\s*[:=]|[{,]\s*domain\s*[,}]/im;

// Non-cookie `domain:` / `domain =` uses, each with a reason. The reviewer checks every entry.
const DOMAIN_KEY_EXEMPT: ReadonlyArray<[file: string, reason: string]> = [];

describe('no cookie is ever scoped to a parent domain (SPEC §8a cookie check)', () => {
  // src plus the root config files that can emit headers or cookies.
  const ROOT_CONFIG = ['next.config.ts', 'vercel.json'].filter((f) => existsSync(f));
  const files = [...walk('src'), ...ROOT_CONFIG].map((f) => [f.replaceAll('\\', '/'), readFileSync(f, 'utf8')] as const);
  it('scans a real tree, including the root config files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(([f]) => f)).toEqual(expect.arrayContaining(['next.config.ts', 'vercel.json', 'src/proxy.ts']));
  });
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
    // Quoted keys and shorthand properties (review round 1).
    expect(DOMAIN_KEY.test("jar.set('x','y',{ 'domain': d })")).toBe(true);
    expect(DOMAIN_KEY.test('jar.set("x","y",{ "Domain": d })')).toBe(true);
    expect(DOMAIN_KEY.test("jar.set('x','y',{ domain })")).toBe(true);
    expect(DOMAIN_KEY.test("jar.set({ name, value, domain, path: '/' })")).toBe(true);
    expect(DOMAIN_KEY.test('{"source":"/x","headers":[{"key":"Set-Cookie","value":"a=b; Domain=.x"}]}')).toBe(true);
    expect(DOMAIN_KEY.test('const subdomain = 1; emailDomain: 2; hasDomain(x)')).toBe(false);
    expect(DOMAIN_KEY.test(stripComments('// domain: amountInr'))).toBe(false);
    expect(DOMAIN_KEY.test(stripComments('/* domain: x */ const a = 1;'))).toBe(false);
    expect(DOMAIN_KEY.test(stripComments("const u = 'https://x.y/z'; // domain: q"))).toBe(false);
  });
});
