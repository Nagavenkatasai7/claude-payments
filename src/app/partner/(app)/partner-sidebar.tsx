'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { Sidebar } from '@/components/ds';
import { dsCn } from '@/lib/ui/ds-cn';

export type PartnerNavItem = { href: string; label: string };

// A link is current on an exact match for the /partner root, and on a prefix match below it
// (so /partner/transfers/abc keeps "Transfers" current, while "Home" is current only on /partner).
export function isCurrent(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === '/partner') return pathname === '/partner';
  return pathname === href || pathname.startsWith(`${href}/`);
}

const MOBILE_LINK =
  'flex min-h-11 items-center rounded-ds-inner px-3 text-[15px] font-semibold text-ds-ink-muted hover:bg-ds-tint focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

/**
 * The /partner navigation. The items are already filtered by role on the server (partnerNav), so
 * this only marks the current one. Desktop: the ds Sidebar (the ONE `aside.sh-sidebar`). Below lg: a
 * native <details> "Menu" disclosure, which works without JS and fits a 375 px screen.
 */
export function PartnerSidebar({ label, menuLabel, items }: { label: string; menuLabel: string; items: PartnerNavItem[] }) {
  const pathname = usePathname();
  const marked = items.map((i) => ({ ...i, current: isCurrent(i.href, pathname) }));
  return (
    <>
      <details className="group rounded-ds-card border border-ds-border bg-ds-surface lg:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-ds-card px-4 text-[15px] font-semibold text-ds-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring [&::-webkit-details-marker]:hidden">
          {menuLabel}
          <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <nav aria-label={menuLabel} className="border-t border-ds-border p-2">
          <ul className="flex flex-col gap-1">
            {marked.map((i) => (
              <li key={i.href}>
                <Link
                  href={i.href}
                  aria-current={i.current ? 'page' : undefined}
                  className={dsCn(MOBILE_LINK, i.current && 'bg-ds-tint text-ds-primary')}
                >
                  {i.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </details>
      <div className="hidden self-start overflow-hidden rounded-ds-card border border-ds-border lg:sticky lg:top-24 lg:block [&>aside]:border-r-0">
        <Sidebar label={label} items={marked} />
      </div>
    </>
  );
}
