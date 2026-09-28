import type { ReactNode } from 'react';
import Link from 'next/link';
import { dsCn } from '@/lib/ui/ds-cn';

export type SidebarItem = { href: string; label: string; current?: boolean; icon?: ReactNode };

const LINK =
  'flex items-center gap-2.5 rounded-ds-inner px-3 py-2.5 text-[14px] font-semibold text-ds-ink-muted hover:bg-ds-tint focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

/**
 * The app sidebar for NEW routes only. It renders the `aside.sh-sidebar` smoke hook, so it must not be
 * mounted on an existing dashboard page. The caller marks the current item; only that link gets
 * aria-current="page".
 */
export function Sidebar({ label, items, brand }: { label: string; items: SidebarItem[]; brand?: ReactNode }) {
  return (
    <aside className="sh-sidebar flex flex-col gap-4 border-r border-ds-border bg-ds-surface p-4" aria-label={label}>
      {brand ? <div className="px-3">{brand}</div> : null}
      <nav>
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                aria-current={item.current ? 'page' : undefined}
                href={item.href}
                className={dsCn(LINK, item.current && 'bg-ds-tint text-ds-primary')}
              >
                {item.icon ? <span aria-hidden="true" className="size-4 shrink-0">{item.icon}</span> : null}
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
