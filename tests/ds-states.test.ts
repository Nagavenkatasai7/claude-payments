import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('state components', () => {
  it('SegmentError never renders the error message or stack, only the digest', async () => {
    const { SegmentError } = await import('@/components/ds/segment-error');
    const err = Object.assign(new Error('db exploded for customer-ref-XYZ acct 12345678'), { digest: 'abc123' });
    const html = renderToStaticMarkup(createElement(SegmentError, { error: err, retry: () => {} }));
    expect(html).not.toContain('exploded');
    expect(html).not.toContain('customer-ref-XYZ');
    expect(html).not.toContain('12345678');
    expect(html).not.toContain('at '); // no stack frames
    expect(html).not.toContain('Error:');
    expect(html).toContain('abc123');
    expect(html).toContain('Try again');
    expect(html).toMatch(/role="alert"/);
  });
  it('SegmentError without a digest renders no reference line', async () => {
    const { SegmentError } = await import('@/components/ds/segment-error');
    const html = renderToStaticMarkup(createElement(SegmentError, { error: new Error('secret 9876543210'), retry: () => {} }));
    expect(html).not.toContain('secret');
    expect(html).not.toContain('Reference');
  });
  it('ErrorState is brand-neutral (it also renders under white-label shells)', async () => {
    const { ErrorState } = await import('@/components/ds/error-state');
    const html = renderToStaticMarkup(createElement(ErrorState, {}));
    expect(html).not.toMatch(/smartremit/i);
    expect(html).toContain('Something went wrong');
    expect(html).not.toContain('<button'); // no retry without a handler
  });
  it('EmptyState renders a heading, the default title via t(), and an optional action', async () => {
    const { EmptyState } = await import('@/components/ds/empty-state');
    const html = renderToStaticMarkup(createElement(EmptyState, { action: createElement('a', { href: '/x' }, 'Add one') }));
    expect(html).toMatch(/<h2[^>]*>Nothing here yet<\/h2>/);
    expect(html).toContain('href="/x"');
  });
  it('EmptyState takes a caller title and body', async () => {
    const { EmptyState } = await import('@/components/ds/empty-state');
    const html = renderToStaticMarkup(createElement(EmptyState, { title: 'No transfers', body: 'Send your first one.' }));
    expect(html).toContain('No transfers');
    expect(html).toContain('Send your first one.');
    expect(html).not.toContain('Nothing here yet');
  });
  it('RouteLoading is announced to assistive tech', async () => {
    const { RouteLoading } = await import('@/components/ds/route-loading');
    const html = renderToStaticMarkup(createElement(RouteLoading, {}));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading…');
    expect(html.match(/animate-pulse/g)).toHaveLength(4);
    const three = renderToStaticMarkup(createElement(RouteLoading, { rows: 3 }));
    expect(three.match(/animate-pulse/g)).toHaveLength(3);
  });
  it('the error boundary module is a Client Component', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/components/ds/segment-error.tsx', 'utf8').trimStart()).toMatch(/^'use client';/);
  });
});
