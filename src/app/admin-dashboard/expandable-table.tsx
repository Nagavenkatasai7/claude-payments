'use client';

import { useId, useState, type ReactNode } from 'react';

/**
 * Responsive data table for the admin dashboard.
 *
 * Desktop (≥768px, `md:`): renders a normal table — identical to the static
 * tables it replaces.
 * Mobile (<768px): `thead` is hidden and each row becomes a labeled card (the
 * column label is painted per-cell via a `before:content-[attr(data-label)]`
 * pseudo-element). Columns marked `primary` stay visible; the rest collapse
 * behind a per-row "Details" disclosure (a real <button aria-expanded>). A
 * table whose columns are ALL primary (≤ a few columns) simply shows every
 * field as a card — no toggle.
 *
 * Cells are passed PRE-RENDERED (ReactNode), so a server page can keep fetching
 * data and can embed <Link>, pills, masked components, and <form action={…}> with
 * server actions — all cross the server→client boundary as elements, no functions.
 */

export interface ExpandableColumn {
  /** Header text; also used as the per-cell label on mobile (via data-label). */
  label: string;
  /** Visible on mobile when the row is collapsed. Default: false (collapses). */
  primary?: boolean;
  /** Right-align the column (e.g. amounts). */
  align?: 'right';
  /** Extra class on the <th> and matching <td>. */
  className?: string;
}

export interface ExpandableRow {
  key: string;
  /** One ReactNode per column, in the same order as `columns`. */
  cells: ReactNode[];
  /** Optional subject name, appended to the toggle's accessible label. */
  label?: string;
}

interface ExpandableTableProps {
  columns: ExpandableColumn[];
  rows: ExpandableRow[];
  /** Shown (in place of the table body) when there are no rows. */
  empty?: ReactNode;
  className?: string;
}

const TH_BASE =
  'border-b border-border bg-background px-4 py-[11px] text-[11px] font-semibold tracking-[0.4px] whitespace-nowrap text-muted-foreground uppercase';

/* Desktop: classic table cell. Mobile: a label/value flex row inside the card —
 * the label comes from data-label via the ::before pseudo-element. */
const TD_BASE =
  'flex-wrap items-center justify-between gap-x-3.5 gap-y-1.5 border-t border-muted px-3.5 py-2.5 leading-[1.45] text-foreground md:px-4 md:py-[13px] md:align-top ' +
  'max-md:break-words max-md:first:border-t-0 ' +
  'max-md:before:flex-none max-md:before:text-left max-md:before:text-[11px] max-md:before:font-semibold max-md:before:tracking-[0.3px] max-md:before:whitespace-nowrap max-md:before:text-muted-foreground max-md:before:uppercase max-md:before:content-[attr(data-label)]';

export function ExpandableTable({ columns, rows, empty, className }: ExpandableTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const baseId = useId();
  const hasSecondary = columns.some((c) => !c.primary);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (rows.length === 0 && empty !== undefined) {
    return <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">{empty}</div>;
  }

  return (
    <div className="w-full overflow-x-auto max-md:overflow-x-visible">
      <table
        className={`w-full border-collapse text-[13px] max-md:block${className ? ` ${className}` : ''}`}
      >
        <thead className="max-md:hidden">
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                className={`${TH_BASE} ${c.align === 'right' ? 'text-right' : 'text-left'}${c.className ? ` ${c.className}` : ''}`}
              >
                {c.label}
              </th>
            ))}
            {hasSecondary && <th className="hidden" aria-hidden="true" />}
          </tr>
        </thead>
        <tbody className="max-md:block">
          {rows.map((row) => {
            const isOpen = expanded.has(row.key);
            const rowId = `${baseId}-${row.key}`;
            return (
              <tr
                key={row.key}
                id={rowId}
                className="transition-colors md:hover:bg-background max-md:mb-3 max-md:block max-md:overflow-hidden max-md:rounded-lg max-md:border max-md:border-border max-md:bg-card"
              >
                {row.cells.map((cell, i) => {
                  const col = columns[i];
                  return (
                    <td
                      key={i}
                      data-label={col?.label}
                      className={`${col?.primary || isOpen ? 'flex' : 'hidden'} md:table-cell ${TD_BASE} ${
                        col?.align === 'right' ? 'text-right' : 'max-md:text-right'
                      }${col?.className ? ` ${col.className}` : ''}`}
                    >
                      {cell}
                    </td>
                  );
                })}
                {hasSecondary && (
                  <td className="block border-t border-muted px-3.5 py-2 md:hidden">
                    <button
                      type="button"
                      className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-[7px] rounded-md border border-border bg-background px-3 py-2 text-[13px] font-semibold text-primary hover:bg-accent"
                      aria-expanded={isOpen}
                      aria-controls={rowId}
                      onClick={() => toggle(row.key)}
                    >
                      <span
                        className={`h-[7px] w-[7px] border-r-2 border-b-2 border-current transition-transform duration-200 motion-reduce:transition-none ${
                          isOpen ? 'mt-0.5 rotate-[-135deg]' : '-mt-0.5 rotate-45'
                        }`}
                        aria-hidden="true"
                      />
                      <span>{isOpen ? 'Hide' : 'Details'}</span>
                      {row.label ? <span className="sr-only"> for {row.label}</span> : null}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
