import { describe, it, expect } from 'vitest';
import { visibleNavGroups, visibleNavItems, NAV_META } from '@/app/admin-dashboard/nav';
import { buildCommandItems } from '@/app/admin-dashboard/command-items';
import { resolveNavItems } from '@/app/admin-dashboard/nav';
import { SUPPORT_DEFAULT_PERMISSIONS, type Staff } from '@/lib/types';

const base = {
  name: 'S', permissions: { canCancel: false, canResend: false, canAssign: false },
  passwordHash: 'x', createdAt: '2026-01-01T00:00:00.000Z',
};
const support: Staff = { ...base, username: 'sup1', role: 'support' };
const platformAdmin: Staff = { ...base, username: 'adm', role: 'admin' };
const partnerAgent: Staff = { ...base, username: 'ag', role: 'agent', partnerId: 'p1' };

describe('support role — nav', () => {
  it('support staff see ONLY ticket surfaces — never money/people/platform', () => {
    const items = visibleNavItems(support);
    expect(items).toEqual(['tickets', 'my-queue', 'employee-questions']);
    for (const banned of ['overview', 'transactions', 'customers', 'compliance', 'partners', 'rates', 'team', 'api-keys'] as const) {
      expect(items).not.toContain(banned);
    }
  });

  it('platform admins gain the Support group incl. employee-questions', () => {
    const items = visibleNavItems(platformAdmin);
    expect(items).toContain('tickets');
    expect(items).toContain('my-queue');
    expect(items).toContain('employee-questions');
    expect(items).toContain('transactions'); // money intact for admins
  });

  it('partner agents get tickets but NOT the admin-only employee-questions queue', () => {
    const items = visibleNavItems(partnerAgent);
    expect(items).toContain('tickets');
    expect(items).not.toContain('employee-questions');
  });

  it('every nav item resolves meta (label/icon/href)', () => {
    for (const key of visibleNavItems(support)) {
      expect(NAV_META[key].label).toBeTruthy();
      expect(NAV_META[key].hrefFor(support)).toMatch(/^\/admin-dashboard/);
    }
  });

  it('nav groups for support carry no unlabeled money group', () => {
    const groups = visibleNavGroups(support);
    expect(groups.map((g) => g.label)).toEqual(['Support', 'Help']);
  });
});

describe('support role — command palette', () => {
  it('support staff get no compliance/money quick actions', () => {
    const items = buildCommandItems(resolveNavItems(support), {
      isPlatformAdmin: false, isAdmin: false, isSupport: true,
    });
    expect(items.find((i) => i.id === 'act-flagged')).toBeUndefined();
    expect(items.find((i) => i.id === 'act-new-customer')).toBeUndefined();
    expect(items.find((i) => i.id === 'nav-tickets')).toBeTruthy();
  });

  it('admins keep their actions', () => {
    const items = buildCommandItems(resolveNavItems(platformAdmin), {
      isPlatformAdmin: true, isAdmin: true, isSupport: false,
    });
    expect(items.find((i) => i.id === 'act-flagged')).toBeTruthy();
  });
});

describe('support role — defaults', () => {
  it('SUPPORT_DEFAULT_PERMISSIONS grants no money permission', () => {
    expect(SUPPORT_DEFAULT_PERMISSIONS).toEqual({ canCancel: false, canResend: false, canAssign: false });
  });
});
