import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('PageHeader / Sidebar keep the e2e hooks', () => {
  it('PageHeader renders .sh-page-head > h1.sh-page-title + p.sh-page-sub with the landing heading look', async () => {
    const { PageHeader } = await import('@/components/ds/page-header');
    const html = renderToStaticMarkup(createElement(PageHeader, { title: 'Overview', sub: 'Today' }));
    expect(html).toMatch(/<div class="sh-page-head[^"]*">/);
    expect(html).toMatch(/<h1 class="sh-page-title[^"]*text-ds-ink[^"]*font-extrabold[^"]*">Overview<\/h1>/);
    expect(html).toMatch(/<p class="sh-page-sub[^"]*">Today<\/p>/);
  });
  it('PageHeader omits the sub line when none is given, and renders actions', async () => {
    const { PageHeader } = await import('@/components/ds/page-header');
    const html = renderToStaticMarkup(createElement(PageHeader, { title: 'X', actions: createElement('button', null, 'New') }));
    expect(html).not.toContain('sh-page-sub');
    expect(html).toContain('<button>New</button>');
  });
  it('Sidebar is aside.sh-sidebar with a labelled nav and aria-current', async () => {
    const { Sidebar } = await import('@/components/ds/sidebar');
    const html = renderToStaticMarkup(createElement(Sidebar, {
      label: 'Main', items: [{ href: '/partner', label: 'Home', current: true }, { href: '/partner/transfers', label: 'Transfers' }],
    }));
    expect(html).toMatch(/<aside class="sh-sidebar[^"]*" aria-label="Main">/);
    expect(html).toContain('<a aria-current="page"');
    expect((html.match(/aria-current/g) ?? []).length).toBe(1);
    expect(html).toContain('<nav');
    expect(html).toContain('href="/partner/transfers"');
  });
});
