// M4 PR-2: guard for everything the docs PUBLISH: the MDX guides, the content
// data modules they render (src/content/**/*.ts) and openapi.yaml (rendered on
// the API reference). No secrets, real phones, internal hosts, env-var names or
// script escape hatches; every guide compiles with the same compiler
// @mdx-js/loader uses. The import/script/compile checks are MDX-only.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const mdx = readdirSync('src/content/docs')
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => join('src/content/docs', f));
const published = [...walk('src/content').filter((f) => /\.(mdx|ts)$/.test(f)), 'openapi.yaml'];

const ALLOWED_HOSTS = [/^smartremit\.ai$/, /(^|\.)example\.com$/, /^business\.facebook\.com$/, /^developers\.facebook\.com$/];
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
  it('uses only the global components PR-3 provides, with real fact names and guide slugs', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const { GUIDES } = await import('@/content/docs/registry');
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of prose.matchAll(/<([A-Za-z][\w.]*)/g)) {
      expect({ tag: m[1], ok: ['Fact', 'TemplateCatalog', 'ErrorStatusTable', 'GuideLink'].includes(m[1]) }).toEqual({ tag: m[1], ok: true });
    }
    for (const m of prose.matchAll(/<Fact name="([^"]+)" \/>/g)) expect(Object.keys(FACTS)).toContain(m[1]);
    for (const m of prose.matchAll(/<GuideLink slug="([^"]+)">/g)) expect(GUIDES.map((g) => g.slug)).toContain(m[1]);
    expect(prose.match(/<Fact\b/g)?.length ?? 0).toBe(prose.match(/<Fact name="[^"]+" \/>/g)?.length ?? 0);
  });
  it('compiles as MDX (the same compiler @mdx-js/loader uses)', async () => {
    const { compile } = await import('@mdx-js/mdx');
    const out = String(await compile(text));
    expect(out).not.toMatch(/dangerouslySetInnerHTML/);
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
