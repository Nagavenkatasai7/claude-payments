import { Fragment } from 'react';
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { NAV_META, visibleNavGroups, type SidebarActive } from './nav';
import { Icon } from './icons';

export type { SidebarActive, NavItem } from './nav';

// Stage 5 IA: the sidebar renders labelled GROUPS (Money · People · Insights ·
// Platform) from the shared nav model — one source of truth with the mobile
// drawer. Styling stays on the proven sh-* classes until the shell's own
// shadcn rebuild lands.

export async function Sidebar({ active }: { active: SidebarActive }) {
  const staff = await requireStaff();
  const groups = visibleNavGroups(staff);

  return (
    <aside className="sh-sidebar">
      {groups.map((group, i) => (
        <Fragment key={group.label ?? `g${i}`}>
          {group.label && <div className="sh-nav-label">{group.label}</div>}
          {group.items.map((key) => (
            <Link
              key={key}
              href={NAV_META[key].hrefFor(staff)}
              className={`sh-nav-item ${active === key ? 'active' : ''}`}
              aria-current={active === key ? 'page' : undefined}
            >
              <span className="sh-nav-icon"><Icon name={NAV_META[key].icon} /></span> {NAV_META[key].label}
            </Link>
          ))}
        </Fragment>
      ))}
    </aside>
  );
}
