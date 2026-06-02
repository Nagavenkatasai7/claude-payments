import { describe, it, expect } from 'vitest';
import { buildCommandItems } from '@/app/admin-dashboard/command-items';
import type { ResolvedNavItem } from '@/app/admin-dashboard/nav';

const nav: ResolvedNavItem[] = [
  { key: 'overview', label: 'Overview', icon: 'overview', href: '/admin-dashboard' },
  { key: 'transactions', label: 'Transactions', icon: 'transactions', href: '/admin-dashboard/transactions' },
];

function ids(items: ReturnType<typeof buildCommandItems>) {
  return items.map((i) => i.id);
}

describe('buildCommandItems', () => {
  it('maps every nav item into a Navigate command', () => {
    const items = buildCommandItems(nav, { isPlatformAdmin: false, isAdmin: false });
    expect(items.find((i) => i.id === 'nav-overview')).toMatchObject({
      group: 'Navigate',
      href: '/admin-dashboard',
    });
    expect(items.find((i) => i.id === 'nav-transactions')?.href).toBe('/admin-dashboard/transactions');
  });

  it('an agent gets only the everyone action (no create actions)', () => {
    const items = buildCommandItems(nav, { isPlatformAdmin: false, isAdmin: false });
    expect(ids(items)).toContain('act-flagged');
    expect(ids(items)).not.toContain('act-new-customer');
    expect(ids(items)).not.toContain('act-new-teammate');
    expect(ids(items)).not.toContain('act-new-partner');
  });

  it('a partner admin gets New customer but not teammate/partner', () => {
    const items = buildCommandItems(nav, { isPlatformAdmin: false, isAdmin: true });
    expect(ids(items)).toContain('act-new-customer');
    expect(ids(items)).not.toContain('act-new-teammate');
    expect(ids(items)).not.toContain('act-new-partner');
  });

  it('a platform admin gets all quick actions', () => {
    const items = buildCommandItems(nav, { isPlatformAdmin: true, isAdmin: true });
    expect(ids(items)).toEqual(
      expect.arrayContaining([
        'act-new-customer',
        'act-new-teammate',
        'act-new-partner',
        'act-flagged',
      ]),
    );
  });
});
