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
    expect(items).not.toContain('my-partner');
  });

  it('platform agent has the same items minus team', () => {
    const items = visibleNavItems(staff('agent', undefined));
    expect(items).toContain('partners');
    expect(items).not.toContain('team');
    expect(items).not.toContain('my-partner');
  });

  it('partner admin sees base + my-partner; never partners or team', () => {
    const items = visibleNavItems(staff('admin', 'acme'));
    expect(items).toContain('overview');
    expect(items).toContain('transactions');
    expect(items).toContain('kyc');
    expect(items).toContain('my-partner');
    expect(items).not.toContain('partners');
    expect(items).not.toContain('team');
  });

  it('partner agent matches partner admin (no team toggle inside partner scope)', () => {
    const items = visibleNavItems(staff('agent', 'acme'));
    expect(items).toContain('my-partner');
    expect(items).not.toContain('partners');
    expect(items).not.toContain('team');
  });
});
