import { describe, it, expect } from 'vitest';
import { visibleNavItems } from '@/app/admin-dashboard/nav';
import type { Staff } from '@/lib/types';

function staff(role: 'admin' | 'agent', partnerId?: string): Staff {
  return {
    username: 'u', name: 'U', role,
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    partnerId,
  };
}

describe('visibleNavItems', () => {
  it('platform admin sees overview/transactions/schedules/customers/compliance/analytics/partners/team', () => {
    const items = visibleNavItems(staff('admin', undefined));
    expect(items).toContain('overview');
    expect(items).toContain('transactions');
    expect(items).toContain('schedules');
    expect(items).toContain('customers');
    expect(items).toContain('compliance');
    expect(items).toContain('kyc');
    expect(items).toContain('analytics');
    expect(items).toContain('partners');
    expect(items).toContain('team');
  });

  it('platform agent has the same items minus team', () => {
    const items = visibleNavItems(staff('agent', undefined));
    expect(items).toContain('partners');
    expect(items).not.toContain('team');
  });

  it('partner-scoped staff get no legacy nav at all (UI M5: requireStaff sends them to /partner)', () => {
    expect(visibleNavItems(staff('admin', 'acme'))).toEqual([]);
    expect(visibleNavItems(staff('agent', 'acme'))).toEqual([]);
  });
});

describe('visibleNavGroups (Stage 5b IA)', () => {
  it('platform groups: top(overview+ops) · Money · People · Support · Insights · Platform', async () => {
    const { visibleNavGroups } = await import('@/app/admin-dashboard/nav');
    const groups = visibleNavGroups(staff('admin', undefined));
    expect(groups[0].items).toEqual(['overview', 'ops']);
    expect(groups.map((g) => g.label)).toEqual([undefined, 'Money', 'People', 'Support', 'Insights', 'Platform']);
    const platform = groups.find((g) => g.label === 'Platform')!;
    expect(platform.items).toEqual(['partners', 'corridors', 'rates', 'b2b', 'partner-requests', 'waitlist', 'team', 'api-keys', 'switches']);
    const supportGroup = groups.find((g) => g.label === 'Support')!;
    expect(supportGroup.items).toEqual(['tickets', 'my-queue', 'employee-questions']);
  });

  it('platform agent: no team, no api-keys in the Platform group', async () => {
    const { visibleNavGroups } = await import('@/app/admin-dashboard/nav');
    const platform = visibleNavGroups(staff('agent', undefined)).find((g) => g.label === 'Platform')!;
    expect(platform.items).toEqual(['partners', 'corridors', 'rates', 'b2b']);
  });

  it('partner-scoped staff: no groups', async () => {
    const { visibleNavGroups } = await import('@/app/admin-dashboard/nav');
    expect(visibleNavGroups(staff('admin', 'acme'))).toEqual([]);
  });
});
