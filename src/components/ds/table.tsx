import type { ReactNode } from 'react';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { dsCn } from '@/lib/ui/ds-cn';
import { tableHref, type TableParams } from '@/lib/ui/table-params';

export type TableColumn<T> = { key: string; header: string; sortable?: boolean; cell: (row: T) => ReactNode };

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const PAGE_LINK = `inline-flex min-h-10 items-center rounded-full border border-ds-border-strong bg-ds-surface px-4 text-[13.5px] font-semibold text-ds-ink hover:border-ds-primary/50 ${FOCUS}`;

/**
 * A server-rendered table: sortable headers and pagination are plain links (no client JS). The caller
 * parses `params` with parseTableParams and runs the scoped, paginated query itself.
 */
export function Table<T>({
  caption,
  columns,
  rows,
  total,
  params,
  baseHref,
  currentQuery,
  empty,
  rowKey,
}: {
  caption: string;
  columns: TableColumn<T>[];
  rows: T[];
  total: number;
  params: TableParams;
  baseHref: string;
  currentQuery: URLSearchParams;
  empty: ReactNode;
  rowKey?: (row: T, index: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / params.limit));
  const page = Math.min(params.page, pages);
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface">
        <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
            <tr>
              {columns.map((col) => {
                const sorted = params.sort === col.key;
                const ariaSort = sorted ? (params.dir === 'asc' ? 'ascending' : 'descending') : undefined;
                return (
                  <th key={col.key} scope="col" aria-sort={ariaSort} className="px-4 py-3 font-semibold">
                    {col.sortable ? (
                      <Link
                        href={tableHref(baseHref, currentQuery, {
                          sort: col.key,
                          dir: sorted && params.dir === 'desc' ? 'asc' : 'desc',
                        })}
                        aria-label={t('ds.table.sortBy', { column: col.header })}
                        className={dsCn('rounded-ds-focus hover:text-ds-ink', sorted && 'text-ds-ink', FOCUS)}
                      >
                        {col.header}
                        {sorted ? <span aria-hidden="true">{params.dir === 'asc' ? ' ↑' : ' ↓'}</span> : null}
                      </Link>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-ds-ink-muted">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={rowKey ? rowKey(row, i) : i} className="border-t border-ds-border">
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-3">
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {total > 0 ? (
        <nav aria-label={caption} className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13.5px] text-ds-ink-muted">{t('ds.table.pageOf', { page, pages })}</span>
          <span className="flex gap-2">
            {page > 1 ? (
              <Link href={tableHref(baseHref, currentQuery, { page: page - 1 })} rel="prev" className={PAGE_LINK}>
                {t('ds.table.prev')}
              </Link>
            ) : null}
            {page < pages ? (
              <Link href={tableHref(baseHref, currentQuery, { page: page + 1 })} rel="next" className={PAGE_LINK}>
                {t('ds.table.next')}
              </Link>
            ) : null}
          </span>
        </nav>
      ) : null}
    </div>
  );
}
