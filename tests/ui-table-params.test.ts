import { describe, it, expect } from 'vitest';
import { parseTableParams, tableHref } from '@/lib/ui/table-params';

const OPTS = { sorts: ['created', 'amount'] as const, defaultSort: 'created', pageSize: 25 };
describe('parseTableParams', () => {
  it('defaults', () => {
    expect(parseTableParams({}, OPTS)).toEqual({ page: 1, sort: 'created', dir: 'desc', offset: 0, limit: 25 });
  });
  it('refuses an unlisted sort key (no column injection)', () => {
    expect(parseTableParams({ sort: 'phone; drop' }, OPTS).sort).toBe('created');
    expect(parseTableParams({ sort: '__proto__' }, OPTS).sort).toBe('created');
  });
  it('clamps junk and huge pages', () => {
    expect(parseTableParams({ page: '-3' }, OPTS).page).toBe(1);
    expect(parseTableParams({ page: 'abc' }, OPTS).page).toBe(1);
    expect(parseTableParams({ page: '999999999' }, OPTS).page).toBe(10_000);
    expect(parseTableParams({ page: '2.9' }, OPTS).page).toBe(2);
  });
  it('takes the first value of a repeated param and only asc/desc', () => {
    expect(parseTableParams({ sort: ['amount', 'created'], dir: 'sideways' }, OPTS)).toMatchObject({ sort: 'amount', dir: 'desc' });
    expect(parseTableParams({ dir: 'asc' }, OPTS).dir).toBe('asc');
  });
  it('offset follows page and page size; the default page size is 25', () => {
    expect(parseTableParams({ page: '3' }, { sorts: ['a'], defaultSort: 'a' })).toMatchObject({ offset: 50, limit: 25 });
  });
});
describe('tableHref', () => {
  it('patches page/sort and keeps other filters', () => {
    expect(tableHref('/partner/transfers', new URLSearchParams('q=abc&page=2'), { page: 3 })).toBe('/partner/transfers?q=abc&page=3');
  });
  it('a sort change resets to page 1', () => {
    expect(tableHref('/t', new URLSearchParams('page=4'), { sort: 'amount', dir: 'asc' })).toBe('/t?sort=amount&dir=asc');
  });
  it('the prev link to page 1 keeps page=1', () => {
    expect(tableHref('/t', new URLSearchParams('page=2'), { page: 1 })).toBe('/t?page=1');
  });
  it('encodes filter values', () => {
    expect(tableHref('/t', new URLSearchParams([['q', 'a b&c']]), { page: 2 })).toBe('/t?q=a+b%26c&page=2');
  });
});

describe('tableSorts', () => {
  it('derives the allowed sort keys from the columns marked sortable, so none silently falls back', async () => {
    const { tableSorts } = await import('@/lib/ui/table-params');
    const cols = [{ key: 'created', sortable: true }, { key: 'recipient' }, { key: 'amount', sortable: true }];
    const sorts = tableSorts(cols);
    expect(sorts).toEqual(['created', 'amount']);
    for (const c of cols.filter((x) => x.sortable)) expect(parseTableParams({ sort: c.key }, { sorts, defaultSort: 'created' }).sort).toBe(c.key);
    expect(parseTableParams({ sort: 'recipient' }, { sorts, defaultSort: 'created' }).sort).toBe('created');
  });
});
