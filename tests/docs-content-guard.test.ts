// M4 PR-2: guard for everything the docs PUBLISH: the MDX guides, the content
// data modules they render (src/content/**/*.ts) and openapi.yaml (rendered on
// the API reference). No secrets, real phones, internal hosts, env-var names or
// script escape hatches; every guide compiles with the same compiler and
// remark plugins @mdx-js/loader uses. The import/script/compile checks are MDX-only.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const mdx = readdirSync('src/content/docs')
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => join('src/content/docs', f));
const published = [...walk('src/content').filter((f) => /\.(mdx|ts)$/.test(f)), 'openapi.yaml'];

// github.com: /trust links the public repository's SECURITY.md (src/content/trust/disclosure.ts).
const ALLOWED_HOSTS = [/^smartremit\.ai$/, /(^|\.)example\.com$/, /^business\.facebook\.com$/, /^developers\.facebook\.com$/, /^github\.com$/];
// Exact documented values only. Writers use these, or placeholders like `<unix seconds>`.
const ALLOWED_DIGIT_RUNS = new Set([
  '000000000000', // the reference rail's documented failure account
  '1790000000', // the sample signature timestamp t=
  '123456789012', // the sample 12-digit bank account in request examples
]);
const FICTIONAL_PHONE = /^1\d{3}55501\d{2}$/; // +1 NXX 555 01XX

describe('the guard has something to scan', () => {
  it('finds the 11 guides and openapi.yaml', () => {
    expect(mdx).toHaveLength(11);
    expect(published).toContain('openapi.yaml');
  });
});

describe.each(mdx)('%s (MDX-only checks)', (f) => {
  const text = readFileSync(f, 'utf8');
  it('has no import/export, script, iframe, style or raw-HTML escape hatch', () => {
    expect(text).not.toMatch(/^\s*(import|export)\s/m);
    expect(text).not.toMatch(/<\s*(script|iframe|style|object|embed)\b/i);
    expect(text).not.toMatch(/dangerouslySetInnerHTML|javascript:/i);
  });
  it('starts at h2 (the page supplies the one h1)', () => {
    expect(text).not.toMatch(/^# /m);
    expect(text.trimStart()).toMatch(/^## /);
  });
  it('never links the unlinked preview routes', () => {
    expect(text).not.toMatch(/\/(docs-next|trust)\b/);
  });
  it('makes no certification or over-claim', () => {
    expect(text).not.toMatch(/\bcompliant\b|\bcertified\b|SOC ?2|\bOFAC\b|PCI/i);
  });
  // PR #385 review round 1: an AST walk, not a regex. The same remark plugin runs in the MDX
  // loader (next.config.ts), so the build refuses expressions, ESM and unknown components too.
  it('is data only (no expressions, ESM or unknown components), with real fact names and guide slugs', async () => {
    const { compile } = await import('@mdx-js/mdx');
    const { default: remarkGfm } = await import('remark-gfm');
    const { default: remarkNoMdxExpressions } = await import('../src/lib/mdx/remark-no-mdx-expressions.mjs');
    const { FACTS } = await import('@/content/docs/facts');
    const { GUIDES } = await import('@/content/docs/registry');
    type Node = { type: string; name?: string | null; attributes?: Array<{ name?: string; value?: unknown }>; children?: Node[] };
    let tree: Node | undefined;
    const capture = () => (t: Node) => {
      tree = t;
    };
    const out = String(await compile(text, { remarkPlugins: [remarkGfm, remarkNoMdxExpressions, capture] }));
    expect(out).not.toMatch(/dangerouslySetInnerHTML/);
    const elements: Node[] = [];
    const visit = (n: Node) => {
      if (n.type === 'mdxJsxFlowElement' || n.type === 'mdxJsxTextElement') elements.push(n);
      n.children?.forEach(visit);
    };
    visit(tree!);
    const attr = (n: Node, k: string) => n.attributes?.find((a) => a.name === k)?.value;
    for (const n of elements.filter((e) => e.name === 'Fact')) expect(Object.keys(FACTS)).toContain(attr(n, 'name'));
    for (const n of elements.filter((e) => e.name === 'GuideLink')) expect(GUIDES.map((g) => g.slug)).toContain(attr(n, 'slug'));
  });
});

describe.each(published)('%s (published-content checks)', (f) => {
  const text = readFileSync(f, 'utf8');
  it('contains no real-looking API key', () => {
    expect(text).not.toMatch(/sr_(live|test)_[A-Za-z0-9]/);
  });
  it('contains no phone or account number except fictional/allow-listed ones', () => {
    for (const m of text.matchAll(/\+?\d[\d\s().-]{8,}\d/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length < 10) continue;
      expect({ found: m[0], ok: FICTIONAL_PHONE.test(digits) || ALLOWED_DIGIT_RUNS.has(digits) }).toEqual({ found: m[0], ok: true });
    }
  });
  it('links only to allow-listed hosts', () => {
    for (const m of text.matchAll(/https?:\/\/([^/\s)"'`>]+)/g)) {
      expect({ host: m[1], ok: ALLOWED_HOSTS.some((r) => r.test(m[1])) }).toEqual({ host: m[1], ok: true });
    }
  });
  it('names no environment variable and no internal host', () => {
    const envNames = readFileSync('.env.example', 'utf8').match(/^[A-Z][A-Z0-9_]+(?==)/gm) ?? [];
    expect(envNames.length).toBeGreaterThan(10);
    for (const n of envNames) expect({ n, found: text.includes(n) }).toEqual({ n, found: false });
    expect(text).not.toMatch(/vercel\.app|neon\.tech|upstash\.io|localhost|127\.0\.0\.1|\.internal\b|ollama\.com/i);
  });
});
