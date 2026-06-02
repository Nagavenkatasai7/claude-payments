'use client';

import { useId, useState, type ReactNode } from 'react';

/**
 * Responsive data table for the admin dashboard.
 *
 * Desktop (≥768px): renders a normal `.sh-table` — identical to the static tables
 * it replaces.
 * Mobile (<768px): `thead` is hidden and each row becomes a labeled card. Columns
 * marked `primary` stay visible; the rest collapse behind a per-row "Details"
 * disclosure (a real <button aria-expanded>). A table whose columns are ALL primary
 * (≤ a few columns) simply shows every field as a card — no toggle.
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
    return <div className="sh-empty">{empty}</div>;
  }

  return (
    <div className="sh-exp-wrap">
      <table className={`sh-table sh-table--exp${className ? ` ${className}` : ''}`}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                className={`${c.align === 'right' ? 'sh-cell-right' : ''}${c.className ? ` ${c.className}` : ''}`}
              >
                {c.label}
              </th>
            ))}
            {hasSecondary && <th className="sh-exp-toggle-cell" aria-hidden="true" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isOpen = expanded.has(row.key);
            const rowId = `${baseId}-${row.key}`;
            return (
              <tr key={row.key} id={rowId} className={isOpen ? 'is-expanded' : ''}>
                {row.cells.map((cell, i) => {
                  const col = columns[i];
                  return (
                    <td
                      key={i}
                      data-label={col?.label}
                      className={`${col?.primary ? 'sh-td--primary' : 'sh-td--secondary'}${
                        col?.align === 'right' ? ' sh-cell-right' : ''
                      }${col?.className ? ` ${col.className}` : ''}`}
                    >
                      {cell}
                    </td>
                  );
                })}
                {hasSecondary && (
                  <td className="sh-exp-toggle-cell">
                    <button
                      type="button"
                      className="sh-exp-toggle"
                      aria-expanded={isOpen}
                      aria-controls={rowId}
                      onClick={() => toggle(row.key)}
                    >
                      <span className="sh-exp-chevron" aria-hidden="true" />
                      <span>{isOpen ? 'Hide' : 'Details'}</span>
                      {row.label ? (
                        <span className="sh-visually-hidden"> for {row.label}</span>
                      ) : null}
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
