import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

describe('ds Table', () => {
  const columns = [{ key: 'id', header: 'ID', sortable: true, cell: (r: { id: string }) => r.id }];
  it('renders the empty row when there are no rows', async () => {
    const { Table } = await import('@/components/ds/table');
    const html = renderToStaticMarkup(createElement(Table<{ id: string }>, {
      caption: 'Transfers', columns, rows: [], total: 0,
      params: { page: 1, sort: 'id', dir: 'desc', offset: 0, limit: 25 },
      baseHref: '/t', currentQuery: new URLSearchParams(), empty: 'No transfers yet',
    }));
    expect(html).toMatch(/<td colSpan="1"[^>]*>No transfers yet/i);
    expect(html).toContain('<caption');
    expect(html).not.toContain('Page 1 of');
  });
  it('marks the sorted column with aria-sort and links pages', async () => {
    const { Table } = await import('@/components/ds/table');
    const html = renderToStaticMarkup(createElement(Table<{ id: string }>, {
      caption: 'T', columns, rows: [{ id: 'a' }], total: 60,
      params: { page: 2, sort: 'id', dir: 'desc', offset: 25, limit: 25 },
      baseHref: '/t', currentQuery: new URLSearchParams('page=2'), empty: '-',
    }));
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('href="/t?page=1"');
    expect(html).toContain('href="/t?page=3"');
    expect(html).toContain('Page 2 of 3');
  });
  it('clicking the sorted header flips the direction; the first and last page have no dead links', async () => {
    const { Table } = await import('@/components/ds/table');
    const html = renderToStaticMarkup(createElement(Table<{ id: string }>, {
      caption: 'T', columns, rows: [{ id: 'a' }], total: 10,
      params: { page: 1, sort: 'id', dir: 'desc', offset: 0, limit: 25 },
      baseHref: '/t', currentQuery: new URLSearchParams(), empty: '-',
    }));
    expect(html).toContain('href="/t?sort=id&amp;dir=asc"');
    expect(html).not.toContain('page=0');
    expect(html).not.toContain('page=2');
  });
  it('an unsorted sortable column has no aria-sort', async () => {
    const { Table } = await import('@/components/ds/table');
    const cols = [...columns, { key: 'amount', header: 'Amount', sortable: true, cell: () => '1' }];
    const html = renderToStaticMarkup(createElement(Table<{ id: string }>, {
      caption: 'T', columns: cols, rows: [{ id: 'a' }], total: 1,
      params: { page: 1, sort: 'id', dir: 'asc', offset: 0, limit: 25 },
      baseHref: '/t', currentQuery: new URLSearchParams(), empty: '-',
    }));
    expect((html.match(/aria-sort=/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-sort="ascending"');
  });
});
