// Server-side table state from search params. Search params are edge input: the sort key is
// allowlisted (never interpolated into SQL by name unless listed), the page is clamped, and only
// 'asc' / 'desc' are accepted.
export type SortDir = 'asc' | 'desc';
export type TableParams = { page: number; sort: string; dir: SortDir; offset: number; limit: number };
type SearchParams = Record<string, string | string[] | undefined>;

export const MAX_PAGE = 10_000;
const DEFAULT_PAGE_SIZE = 25;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function parseTableParams(
  sp: SearchParams,
  opts: { sorts: readonly string[]; defaultSort: string; pageSize?: number },
): TableParams {
  const raw = Number.parseInt(first(sp.page) ?? '1', 10);
  const page = Math.min(Math.max(Number.isFinite(raw) ? raw : 1, 1), MAX_PAGE);
  const s = first(sp.sort);
  const sort = s !== undefined && opts.sorts.includes(s) ? s : opts.defaultSort;
  const dir: SortDir = first(sp.dir) === 'asc' ? 'asc' : 'desc';
  const limit = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  return { page, sort, dir, offset: (page - 1) * limit, limit };
}

/** A link to the same table with page/sort patched; other params (filters) are kept. A sort change resets the page. */
export function tableHref(
  base: string,
  current: URLSearchParams,
  patch: Partial<{ page: number; sort: string; dir: SortDir }>,
): string {
  const next = new URLSearchParams(current);
  if (patch.sort !== undefined || patch.dir !== undefined) {
    next.delete('page');
    if (patch.sort !== undefined) next.set('sort', patch.sort);
    if (patch.dir !== undefined) next.set('dir', patch.dir);
  }
  if (patch.page !== undefined) next.set('page', String(patch.page));
  const qs = next.toString();
  return qs ? `${base}?${qs}` : base;
}
