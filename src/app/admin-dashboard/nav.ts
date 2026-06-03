import type { Staff } from '@/lib/types';
import type { IconName } from './icons';

/**
 * Shared navigation model for the admin dashboard.
 *
 * Lives in its own module (no 'use client', no server-only imports) so BOTH the
 * server-rendered desktop <Sidebar> and the client-rendered mobile <MobileNav>
 * drawer can import the same source of truth — the nav is defined once.
 */
export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'customers'
  | 'partners'
  | 'compliance'
  | 'kyc'
  | 'analytics'
  | 'corridors'
  | 'team'
  | 'my-partner';

export type NavItem = SidebarActive;

export function visibleNavItems(staff: Staff): NavItem[] {
  const base: NavItem[] = [
    'overview', 'transactions', 'schedules',
    'customers', 'compliance', 'kyc', 'analytics',
  ];
  if (!staff.partnerId) {
    // Platform: base + Partners list + Corridors (lead page) + (Team only if admin)
    return [
      ...base,
      'partners',
      'corridors',
      ...(staff.role === 'admin' ? (['team'] as NavItem[]) : []),
    ];
  }
  // Partner-scoped: base + direct link to their own partner detail
  return [...base, 'my-partner'];
}

interface NavMeta {
  label: string;
  icon: IconName;
  hrefFor: (staff: Staff) => string;
}

export const NAV_META: Record<NavItem, NavMeta> = {
  overview:     { label: 'Overview',     icon: 'overview',     hrefFor: () => '/admin-dashboard' },
  transactions: { label: 'Transactions', icon: 'transactions', hrefFor: () => '/admin-dashboard/transactions' },
  schedules:    { label: 'Schedules',    icon: 'schedules',    hrefFor: () => '/admin-dashboard/schedules' },
  customers:    { label: 'Customers',    icon: 'customers',    hrefFor: () => '/admin-dashboard/customers' },
  partners:     { label: 'Partners',     icon: 'partners',     hrefFor: () => '/admin-dashboard/partners' },
  compliance:   { label: 'Compliance',   icon: 'compliance',   hrefFor: () => '/admin-dashboard/compliance' },
  kyc:          { label: 'KYC',          icon: 'kyc',          hrefFor: () => '/admin-dashboard/kyc' },
  analytics:    { label: 'Analytics',    icon: 'analytics',    hrefFor: () => '/admin-dashboard/analytics' },
  corridors:    { label: 'Corridors',    icon: 'corridors',    hrefFor: () => '/admin-dashboard/corridors' },
  team:         { label: 'Team',         icon: 'team',         hrefFor: () => '/admin-dashboard/team' },
  'my-partner': { label: 'My partner',   icon: 'partners',     hrefFor: (s) => `/admin-dashboard/partners/${s.partnerId}` },
};

/** A nav entry resolved to plain serializable data — safe to pass to a client component. */
export interface ResolvedNavItem {
  key: NavItem;
  label: string;
  icon: IconName;
  href: string;
}

/**
 * Resolve the visible nav into plain data (href computed) for the staff member.
 * Used by the mobile drawer (a client component), which cannot receive the
 * `hrefFor` functions across the server→client boundary.
 */
export function resolveNavItems(staff: Staff): ResolvedNavItem[] {
  return visibleNavItems(staff).map((key) => ({
    key,
    label: NAV_META[key].label,
    icon: NAV_META[key].icon,
    href: NAV_META[key].hrefFor(staff),
  }));
}
