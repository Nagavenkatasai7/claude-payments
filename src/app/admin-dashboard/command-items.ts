import type { IconName } from './icons';
import type { ResolvedNavItem } from './nav';

/**
 * Command-palette item model + builder.
 *
 * Pure / serializable (no JSX, no client APIs) so the server <TopBar> can build
 * the list and hand plain data to the client <CommandPalette>. Every command is
 * a navigation (href); permission-gated quick actions are filtered by the
 * caller-supplied capability flags.
 */
export interface CommandItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  group: string;
  /** Extra search terms (not displayed). Quick actions tag 'action' for the hint. */
  keywords?: string;
}

export interface CommandCaps {
  /** role === 'admin' && no partnerId — sees the whole platform. */
  isPlatformAdmin: boolean;
  /** role === 'admin' (platform OR partner admin). */
  isAdmin: boolean;
  /** role === 'support' — tickets-only; money/compliance actions are hidden. */
  isSupport?: boolean;
}

// Extra search terms for nav entries whose label alone undersells them. The
// Rates page (platform-only; scope-filtered upstream via navItems) is what
// staff reach for when they think "pricing" or "margin", not "rates".
const NAV_KEYWORD_EXTRAS: Partial<Record<ResolvedNavItem['key'], string>> = {
  rates: 'pricing margin bps fx corridor partner best-rate',
  refunds: 'refund reversal reverse chargeback return money back issue approve dismiss retry',
  tickets: 'support ticket queue customer query question help',
  'my-queue': 'support my tickets assigned queue',
  'employee-questions': 'internal ask admin escalate question help',
};

export function buildCommandItems(
  navItems: ResolvedNavItem[],
  caps: CommandCaps,
): CommandItem[] {
  const navigate: CommandItem[] = navItems.map((it) => ({
    id: `nav-${it.key}`,
    label: it.label,
    href: it.href,
    icon: it.icon,
    group: 'Navigate',
    keywords: `go open ${it.key}${NAV_KEYWORD_EXTRAS[it.key] ? ` ${NAV_KEYWORD_EXTRAS[it.key]}` : ''}`,
  }));

  const actions: CommandItem[] = [];
  if (caps.isAdmin) {
    actions.push({
      id: 'act-new-customer',
      label: 'New customer',
      href: '/admin-dashboard/customers/new',
      icon: 'plus',
      group: 'Actions',
      keywords: 'action create add customer sender',
    });
  }
  if (caps.isPlatformAdmin) {
    actions.push(
      {
        id: 'act-new-teammate',
        label: 'Add teammate',
        href: '/admin-dashboard/team/new',
        icon: 'plus',
        group: 'Actions',
        keywords: 'action create add staff member agent admin teammate invite',
      },
      {
        id: 'act-new-partner',
        label: 'New partner',
        href: '/admin-dashboard/partners/new',
        icon: 'plus',
        group: 'Actions',
        keywords: 'action create add partner tenant',
      },
    );
  }
  // Everyone EXCEPT support (the compliance page bounces them server-side
  // anyway — requireScope — but don't offer the dead-end).
  if (!caps.isSupport) {
    actions.push({
      id: 'act-flagged',
      label: 'Review flagged & blocked',
      href: '/admin-dashboard/compliance',
      icon: 'compliance',
      group: 'Actions',
      keywords: 'action compliance flagged blocked watchlist review hold',
    });
  }

  return [...navigate, ...actions];
}
