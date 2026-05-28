import { Fragment } from 'react';
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import type { Staff } from '@/lib/types';

export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'customers'
  | 'partners'
  | 'compliance'
  | 'analytics'
  | 'team'
  | 'my-partner';

export type NavItem = SidebarActive;

export function visibleNavItems(staff: Staff): NavItem[] {
  const base: NavItem[] = [
    'overview', 'transactions', 'schedules',
    'customers', 'compliance', 'analytics',
  ];
  if (!staff.partnerId) {
    // Platform: base + Partners list + (Team only if admin)
    return [...base, 'partners', ...(staff.role === 'admin' ? (['team'] as NavItem[]) : [])];
  }
  // Partner-scoped: base + direct link to their own partner detail
  return [...base, 'my-partner'];
}

interface NavMeta {
  label: string;
  icon: string;
  hrefFor: (staff: Staff) => string;
}
const NAV_META: Record<NavItem, NavMeta> = {
  overview:     { label: 'Overview',     icon: '◾', hrefFor: () => '/dashboard' },
  transactions: { label: 'Transactions', icon: '↔', hrefFor: () => '/dashboard/transactions' },
  schedules:    { label: 'Schedules',    icon: '↻', hrefFor: () => '/dashboard/schedules' },
  customers:    { label: 'Customers',    icon: '◍', hrefFor: () => '/dashboard/customers' },
  partners:     { label: 'Partners',     icon: '◆', hrefFor: () => '/dashboard/partners' },
  compliance:   { label: 'Compliance',   icon: '⚑', hrefFor: () => '/dashboard/compliance' },
  analytics:    { label: 'Analytics',    icon: '▦', hrefFor: () => '/dashboard/analytics' },
  team:         { label: 'Team',         icon: '◉', hrefFor: () => '/dashboard/team' },
  'my-partner': { label: 'My partner',   icon: '◆', hrefFor: (s) => `/dashboard/partners/${s.partnerId}` },
};

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
        <Link href="/dashboard" className="sh-nav-item">
          <span className="sh-nav-icon">⚙</span> Settings
        </Link>
      )}
    </aside>
  );
}
