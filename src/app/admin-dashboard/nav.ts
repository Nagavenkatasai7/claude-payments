import type { Staff, StaffRole } from '@/lib/types';
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
  | 'ops'
  | 'transactions'
  | 'schedules'
  | 'customers'
  | 'partners'
  | 'compliance'
  | 'kyc'
  | 'analytics'
  | 'corridors'
  | 'b2b'
  | 'partner-requests'
  | 'rates'
  | 'team'
  | 'api-keys'
  | 'tickets'
  | 'my-queue'
  | 'employee-questions'
  | 'refunds'
  | 'waitlist'
  | 'switches'
  | 'rewards';

export type NavItem = SidebarActive;

/** A labelled sidebar section (Stage 5 IA). `label` undefined ⇒ top group. */
export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export function visibleNavGroups(staff: Staff): NavGroup[] {
  // UI M5: requireStaff (src/lib/auth.ts) sends partner-scoped staff to
  // /partner, so they never render this nav. Show them nothing rather than
  // platform links if that ever changes.
  if (staff.partnerId) return [];
  // Support staff are tickets-only: their nav shows nothing else, and the
  // requireScope bounce in src/lib/auth.ts ENFORCES it server-side (the nav
  // is presentation, never the guard). Employee-questions is where support
  // staff ASK admins; admins ANSWER from the same page.
  if (staff.role === 'support') {
    return [
      { label: 'Support', items: ['tickets', 'my-queue'] },
      { label: 'Help', items: ['employee-questions'] },
    ];
  }
  // Platform IA: Home/Operations · Money · People · Insights · Platform.
  return [
    { items: ['overview', 'ops'] },
    { label: 'Money', items: ['transactions', 'schedules', 'refunds'] },
    { label: 'People', items: ['customers', 'kyc', 'compliance'] },
    {
      label: 'Support',
      items: [
        // Agents are ticket handlers of their OWN assigned tickets only — they
        // get My queue, never the global queue (the queue page redirects them).
        ...(staff.role !== 'agent' ? (['tickets'] as NavItem[]) : []),
        'my-queue',
        ...(staff.role === 'admin' ? (['employee-questions'] as NavItem[]) : []),
      ],
    },
    { label: 'Insights', items: ['analytics'] },
    {
      label: 'Platform',
      items: [
        'partners',
        'corridors',
        'rates', // platform-wide cross-tenant pricing — never shown to partner-scoped staff
        'b2b', // B2B invoices + business-to-business transfers — platform-scoped review surface
        // partner-requests + waitlist are SmartRemit's own inbound lists — platform admins only.
        // switches (Release safety part A): the kill switches — platform admins only (requirePlatformAdmin).
        // rewards (B3): the reward catalog, partner money terms and monthly statements — platform admins only.
        ...(staff.role === 'admin' ? (['partner-requests', 'waitlist', 'team', 'api-keys', 'switches', 'rewards'] as NavItem[]) : []),
      ],
    },
  ];
}

/** Flat view of the visible nav (mobile drawer + membership tests). */
export function visibleNavItems(staff: Staff): NavItem[] {
  return visibleNavGroups(staff).flatMap((g) => g.items);
}

interface NavMeta {
  label: string;
  icon: IconName;
  hrefFor: (staff: Staff) => string;
}

export const NAV_META: Record<NavItem, NavMeta> = {
  overview:     { label: 'Overview',     icon: 'overview',     hrefFor: () => '/admin-dashboard' },
  ops:          { label: 'Operations',   icon: 'ops',          hrefFor: () => '/admin-dashboard/ops' },
  'api-keys':   { label: 'API keys',     icon: 'keys',         hrefFor: () => '/admin-dashboard/api-keys' },
  transactions: { label: 'Transactions', icon: 'transactions', hrefFor: () => '/admin-dashboard/transactions' },
  schedules:    { label: 'Schedules',    icon: 'schedules',    hrefFor: () => '/admin-dashboard/schedules' },
  refunds:      { label: 'Refunds',      icon: 'refunds',      hrefFor: () => '/admin-dashboard/refunds' },
  customers:    { label: 'Customers',    icon: 'customers',    hrefFor: () => '/admin-dashboard/customers' },
  partners:     { label: 'Partners',     icon: 'partners',     hrefFor: () => '/admin-dashboard/partners' },
  compliance:   { label: 'Compliance',   icon: 'compliance',   hrefFor: () => '/admin-dashboard/compliance' },
  kyc:          { label: 'KYC',          icon: 'kyc',          hrefFor: () => '/admin-dashboard/kyc' },
  analytics:    { label: 'Analytics',    icon: 'analytics',    hrefFor: () => '/admin-dashboard/analytics' },
  corridors:    { label: 'Corridors',    icon: 'corridors',    hrefFor: () => '/admin-dashboard/corridors' },
  b2b:          { label: 'B2B',           icon: 'building',     hrefFor: () => '/admin-dashboard/b2b' },
  'partner-requests': { label: 'Partner requests', icon: 'building', hrefFor: () => '/admin-dashboard/partner-requests' },
  waitlist:     { label: 'Waitlist',     icon: 'queue',        hrefFor: () => '/admin-dashboard/waitlist' },
  switches:     { label: 'Switches',     icon: 'shield',       hrefFor: () => '/admin-dashboard/switches' },
  rewards:      { label: 'Rewards',      icon: 'rates',        hrefFor: () => '/admin-dashboard/rewards' },
  rates:        { label: 'Rates',        icon: 'rates',        hrefFor: () => '/admin-dashboard/rates' },
  team:         { label: 'Team',         icon: 'team',         hrefFor: () => '/admin-dashboard/team' },
  tickets:      { label: 'Tickets',      icon: 'tickets',      hrefFor: () => '/admin-dashboard/tickets' },
  'my-queue':   { label: 'My queue',     icon: 'queue',        hrefFor: () => '/admin-dashboard/tickets/my-queue' },
  'employee-questions': { label: 'Employee questions', icon: 'question', hrefFor: () => '/admin-dashboard/employee-questions' },
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

/** The role shown beside the staff member's name in the top bar. */
export function staffRoleLabel(role: StaffRole): string {
  const labels: Record<StaffRole, string> = { admin: 'Admin', agent: 'Agent', support: 'Support', finance: 'Finance' };
  return labels[role];
}
