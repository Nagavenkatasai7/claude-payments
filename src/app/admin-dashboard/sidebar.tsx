import { Fragment } from 'react';
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { NAV_META, visibleNavItems, type SidebarActive } from './nav';

export type { SidebarActive, NavItem } from './nav';

export async function Sidebar({ active }: { active: SidebarActive }) {
  const staff = await requireStaff();
  const items = visibleNavItems(staff);
  const showAccountLabel = !staff.partnerId && staff.role === 'admin';

  return (
    <aside className="sh-sidebar">
      {items.map((key) => {
        if (key === 'team' && showAccountLabel) {
          return (
            <Fragment key={key}>
              <div className="sh-nav-label">Account</div>
              <Link
                href={NAV_META[key].hrefFor(staff)}
                className={`sh-nav-item ${active === key ? 'active' : ''}`}
              >
                <span className="sh-nav-icon">{NAV_META[key].icon}</span> {NAV_META[key].label}
              </Link>
            </Fragment>
          );
        }
        return (
          <Link
            key={key}
            href={NAV_META[key].hrefFor(staff)}
            className={`sh-nav-item ${active === key ? 'active' : ''}`}
          >
            <span className="sh-nav-icon">{NAV_META[key].icon}</span> {NAV_META[key].label}
          </Link>
        );
      })}
      {showAccountLabel && (
        <Link href="/admin-dashboard" className="sh-nav-item">
          <span className="sh-nav-icon">⚙</span> Settings
        </Link>
      )}
    </aside>
  );
}
