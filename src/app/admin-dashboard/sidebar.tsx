import { Fragment } from 'react';
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { NAV_META, visibleNavGroups, type SidebarActive } from './nav';
import { Icon } from './icons';

export type { SidebarActive, NavItem } from './nav';

// Stage 5 IA: the sidebar renders labelled GROUPS (Money · People · Insights ·
// Platform) from the shared nav model — one source of truth with the mobile
// drawer. Styled with Tailwind; the literal `sh-sidebar` class is kept ONLY as
// an E2E hook (Playwright selects `aside.sh-sidebar`) — it carries no styling
// the shell depends on.

// Shared nav-item recipe (duplicated in mobile-nav.tsx, which is a client
// component and cannot import this server module).
const navItemBase =
  'relative mb-px flex items-center gap-2.5 rounded-md px-[11px] py-2 text-[13px] font-medium transition-colors';
const navItemIdle = 'text-muted-foreground hover:bg-secondary hover:text-foreground';
const navItemActive =
  "bg-sidebar-accent font-semibold text-sidebar-accent-foreground before:absolute before:-left-3 before:top-1/2 before:h-[18px] before:w-[3px] before:-translate-y-1/2 before:rounded-r-[3px] before:bg-primary before:content-['']";

export async function Sidebar({ active }: { active: SidebarActive }) {
  const staff = await requireStaff();
  const groups = visibleNavGroups(staff);

  return (
    <aside className="sh-sidebar sticky top-14 hidden h-[calc(100vh-56px)] overflow-y-auto border-r border-sidebar-border bg-sidebar px-3 py-3.5 text-sidebar-foreground min-[1025px]:block">
      {groups.map((group, i) => (
        <Fragment key={group.label ?? `g${i}`}>
          {group.label && (
            <div className="mt-3.5 mb-1 px-2.5 py-1 text-[11px] font-semibold tracking-[0.6px] text-muted-foreground uppercase">
              {group.label}
            </div>
          )}
          {group.items.map((key) => (
            <Link
              key={key}
              href={NAV_META[key].hrefFor(staff)}
              className={`${navItemBase} ${active === key ? navItemActive : navItemIdle}`}
              aria-current={active === key ? 'page' : undefined}
            >
              <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center opacity-90 [&_svg]:block [&_svg]:h-[17px] [&_svg]:w-[17px]"><Icon name={NAV_META[key].icon} /></span> {NAV_META[key].label}
            </Link>
          ))}
        </Fragment>
      ))}
    </aside>
  );
}
