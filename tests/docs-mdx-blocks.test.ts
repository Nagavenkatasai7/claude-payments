import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FACTS } from '@/content/docs/facts';
import { TEMPLATES } from '@/content/docs/whatsapp-template-catalog';
import { loadPartnerOpenApi } from '@/lib/openapi/load-spec';

// UI redesign M4 PR-3: the code-backed blocks the guides use without imports
// (src/mdx-components.tsx exposes them). Every number or name they print comes from
// facts.ts / the template catalog / openapi.yaml, so a code change cannot leave a guide stale.

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('<Fact>', () => {
  it('prints a number fact exactly', async () => {
    const { Fact } = await import('@/components/docs/mdx-blocks');
    expect(html(createElement(Fact, { name: 'partnerRateLimitPerMin' }))).toBe('120');
  });
  it('prints a string fact as code', async () => {
    const { Fact } = await import('@/components/docs/mdx-blocks');
    expect(html(createElement(Fact, { name: 'signatureHeader' }))).toMatch(/<code[^>]*>x-smartremit-signature<\/code>/);
  });
  it('formats an array fact (reservedIdempotencyPrefixes) as a comma list of code items, in order', async () => {
    const { Fact } = await import('@/components/docs/mdx-blocks');
    const out = html(createElement(Fact, { name: 'reservedIdempotencyPrefixes' }));
    const items = [...out.matchAll(/<code[^>]*>([^<]+)<\/code>/g)].map((m) => m[1]);
    expect(items).toEqual([...FACTS.reservedIdempotencyPrefixes]);
    expect(out.replace(/<[^>]+>/g, '')).toBe('draft:, b2binvoice:, sched:, test:');
  });
  it('throws for an unknown fact (fails the build, never prints "undefined")', async () => {
    const { Fact } = await import('@/components/docs/mdx-blocks');
    expect(() => html(createElement(Fact, { name: 'nope' as never }))).toThrow(/unknown fact/i);
  });
});

describe('<GuideLink>', () => {
  it('links a registered guide under /docs-next', async () => {
    const { GuideLink } = await import('@/components/docs/mdx-blocks');
    const out = html(createElement(GuideLink, { slug: 'webhooks' }, 'Webhooks'));
    expect(out).toMatch(/^<a [^>]*href="\/docs-next\/webhooks"[^>]*>Webhooks<\/a>$/);
  });
  it('throws for a slug that is not in the registry', async () => {
    const { GuideLink } = await import('@/components/docs/mdx-blocks');
    expect(() => html(createElement(GuideLink, { slug: 'nope' }, 'x'))).toThrow(/unknown guide/i);
  });
});

describe('<ErrorStatusTable>', () => {
  it('has one row per openapi.yaml operation with its exact statuses', async () => {
    const { ErrorStatusTable } = await import('@/components/docs/mdx-blocks');
    const ops = loadPartnerOpenApi();
    const out = html(createElement(ErrorStatusTable));
    const rows = [...out.matchAll(/<tr data-op="([^"]+)">([\s\S]*?)<\/tr>/g)];
    expect(ops).toHaveLength(11);
    expect(rows.map((r) => r[1])).toEqual(ops.map((o) => o.operationId));
    for (const [i, op] of ops.entries()) {
      expect(rows[i][2]).toContain(`${op.method} /api/partner/v1${op.path}`);
      const codes = [...rows[i][2].matchAll(/data-status="(\d+)"/g)].map((m) => Number(m[1]));
      expect({ op: op.operationId, codes }).toEqual({ op: op.operationId, codes: op.statuses });
    }
  });
});

describe('<TemplateCatalog>', () => {
  it('lists every template exactly once, sent-today ones before the "Planned" heading', async () => {
    const { TemplateCatalog } = await import('@/components/docs/mdx-blocks');
    const out = html(createElement(TemplateCatalog));
    const planned = out.indexOf('Planned, not sent yet');
    expect(out.indexOf('Sent from your number today')).toBeGreaterThanOrEqual(0);
    expect(planned).toBeGreaterThan(out.indexOf('Sent from your number today'));
    for (const t of TEMPLATES) {
      const at = [...out.matchAll(new RegExp(`data-template="${t.name}"`, 'g'))].map((m) => m.index!);
      expect({ name: t.name, count: at.length }).toEqual({ name: t.name, count: 1 });
      expect({ name: t.name, planned: at[0] > planned }).toEqual({ name: t.name, planned: !t.sentToday });
    }
  });
  it('prints each body verbatim (HTML-escaped) and its parameter count', async () => {
    const { TemplateCatalog } = await import('@/components/docs/mdx-blocks');
    const out = html(createElement(TemplateCatalog));
    const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
    for (const t of TEMPLATES) {
      expect({ name: t.name, body: out.includes(esc(t.body)) }).toEqual({ name: t.name, body: true });
    }
    expect(out).toContain('Optional (configured)');
  });
  it('a withheld button URL is never printed as a URL', async () => {
    const { TemplateCatalog } = await import('@/components/docs/mdx-blocks');
    const out = html(createElement(TemplateCatalog));
    expect(out).toContain('Published when this template goes live');
    expect(out).not.toMatch(/\/verify\//);
  });
});

describe('mdx-components', () => {
  it('exposes the four blocks and token-styled markdown elements', async () => {
    const { useMDXComponents } = await import('@/mdx-components');
    const c = useMDXComponents();
    for (const k of ['Fact', 'TemplateCatalog', 'ErrorStatusTable', 'GuideLink', 'h2', 'h3', 'p', 'a', 'ul', 'ol', 'code', 'pre', 'table', 'th', 'td'])
      expect({ k, present: k in c }).toEqual({ k, present: true });
  });
  it('external links open safely; internal links stay in the tab', async () => {
    const { useMDXComponents } = await import('@/mdx-components');
    const A = useMDXComponents().a as (p: { href?: string; children?: string }) => React.ReactElement;
    expect(html(A({ href: 'https://developers.facebook.com/', children: 'Meta' }))).toMatch(/rel="noopener noreferrer"/);
    expect(html(A({ href: '/docs', children: 'x' }))).not.toMatch(/target=/);
  });
  it('a markdown table is wrapped so it scrolls inside itself, never the page', async () => {
    const { useMDXComponents } = await import('@/mdx-components');
    const T = useMDXComponents().table as (p: object) => React.ReactElement;
    expect(html(T({}))).toMatch(/^<div class="[^"]*overflow-x-auto[^"]*"><table/);
  });
});
