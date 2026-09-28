import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadPartnerOpenApiDocument } from '@/lib/openapi/load-spec';
import { operationAnchor, schemaAnchor } from '@/lib/docs/api-reference';

// UI redesign M4 PR-4: /docs-next/api renders EVERY operation in openapi.yaml (method, path,
// scope, sandbox availability, parameters, request example, every documented status with its
// body schema, a curl) plus the component schemas, as server-only HTML with stable anchors.

const doc = loadPartnerOpenApiDocument();
const render = async () => {
  const { default: Page } = await import('@/app/docs-next/api/page');
  return renderToStaticMarkup(createElement(Page));
};
const section = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
};
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

describe('/docs-next/api page', () => {
  it('has one h1 "API reference" and one section per operation, keyed by the stable anchor', async () => {
    const html = await render();
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>API reference<\/h1>/);
    const ids = [...html.matchAll(/<section id="([^"]+)" data-op="([^"]+)"/g)].map((m) => [m[2], m[1]]);
    expect(ids).toHaveLength(11);
    expect(Object.fromEntries(ids)).toEqual(Object.fromEntries(doc.operations.map((o) => [o.operationId, operationAnchor(o)])));
  });

  it('each operation shows method, path, summary, scope, sandbox availability, every status and a curl', async () => {
    const html = await render();
    for (const op of doc.operations) {
      const s = text(section(html, operationAnchor(op)));
      expect(s).toContain(op.method);
      expect(s).toContain(op.path);
      expect(s).toContain(op.summary);
      expect(s).toContain(op.scope);
      expect(s).toContain(op.sandbox ? 'Sandbox keys: yes' : 'Sandbox keys: no');
      for (const st of op.statuses) {
        expect(s).toContain(String(st));
        expect(s).toContain(op.responses[st]);
      }
      for (const p of op.parameters) expect(s).toContain(p.name);
      expect(s).toContain(`curl -X ${op.method}`);
      if (op.requestExample !== null) expect(s).toContain('Request body');
    }
  });

  it('links each response body schema to the schema section, which lists every field', async () => {
    const html = await render();
    const confirm = section(html, 'post-transactions-id-confirm');
    expect(confirm).toContain(`href="#${schemaAnchor('Transaction')}"`);
    expect(confirm).toContain(`href="#${schemaAnchor('Error')}"`);
    for (const s of doc.schemas) {
      const block = text(section(html, schemaAnchor(s.name)));
      for (const f of s.fields) {
        expect(block).toContain(f.name);
        expect(block).toContain(f.type);
      }
    }
  });

  it('the on-page index links every operation anchor', async () => {
    const html = await render();
    for (const op of doc.operations) expect(html).toContain(`href="#${operationAnchor(op)}"`);
  });

  it('prints no real-looking key anywhere, and no curl carries a live key prefix', async () => {
    const html = await render();
    expect(html).not.toMatch(/sr_(live|test)_[A-Za-z0-9]/);
    const curls = [...html.matchAll(/<pre aria-label="[^"]*: curl example"[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
    expect(curls).toHaveLength(11);
    for (const c of curls) expect(c).not.toContain('sr_live_');
  });

  it('shows the sandbox pill as text with a hidden icon (never colour only)', async () => {
    const html = await render();
    expect(html).toMatch(/<span aria-hidden="true">✓<\/span>\s*Sandbox keys: yes/);
    expect(html).toMatch(/<span aria-hidden="true">✕<\/span>\s*Sandbox keys: no/);
  });

  it('renders backtick spans in the spec prose as code, never as literal backticks', async () => {
    const html = await render();
    expect(html).toMatch(/<code[^>]*>\{ &quot;error&quot;: &quot;…&quot; \}<\/code>/);
    expect(html).not.toContain('`');
  });
});
