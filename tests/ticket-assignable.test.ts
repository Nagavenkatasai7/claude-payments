import { describe, it, expect } from 'vitest';
import { isTenantTicketAssignee, isTicketAssignable, tenantTicketAssignees, ticketAssigneeRefusal } from '@/lib/ticket-assignable';
import type { Staff } from '@/lib/types';

// The ticket-detail assign dropdown's filter (a page, so the predicate is tested here). The
// assignTicketAction re-validates the same rules on the server.
const mk = (o: Partial<Staff>): Staff => ({
  username: 'u',
  name: 'U',
  role: 'support',
  permissions: { canCancel: false, canResend: false, canAssign: false },
  passwordHash: 'h',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'p1',
  ...o,
});

describe('isTicketAssignable', () => {
  it('admits active, in-scope support, admin and agent staff (platform staff see every tenant)', () => {
    for (const role of ['support', 'admin', 'agent'] as const) expect(isTicketAssignable(mk({ role }), 'p1')).toBe(true);
    expect(isTicketAssignable(mk({ role: 'admin', partnerId: undefined }), 'p1')).toBe(true);
  });
  it('M3-6: refuses finance and any role outside the closed legacy set', () => {
    expect(isTicketAssignable(mk({ role: 'finance' as Staff['role'] }), 'p1')).toBe(false);
    expect(isTicketAssignable(mk({ role: 'root' as Staff['role'] }), 'p1')).toBe(false);
  });
  it('refuses suspended and out-of-scope staff', () => {
    expect(isTicketAssignable(mk({ status: 'suspended' }), 'p1')).toBe(false);
    expect(isTicketAssignable(mk({ partnerId: 'p2' }), 'p1')).toBe(false);
  });
});

describe('ticketAssigneeRefusal (the shared rule behind both assign actions)', () => {
  it('names the first failed rule, in the legacy order: unknown, inactive, scope, role', () => {
    expect(ticketAssigneeRefusal(null, 'p1')).toBe('unknown');
    expect(ticketAssigneeRefusal(mk({ status: 'suspended', partnerId: 'p2' }), 'p1')).toBe('inactive');
    expect(ticketAssigneeRefusal(mk({ partnerId: 'p2', role: 'finance' as Staff['role'] }), 'p1')).toBe('scope');
    expect(ticketAssigneeRefusal(mk({ role: 'finance' as Staff['role'] }), 'p1')).toBe('role');
    expect(ticketAssigneeRefusal(mk({}), 'p1')).toBeNull();
    expect(ticketAssigneeRefusal(mk({ partnerId: undefined }), 'p1')).toBeNull();
  });
});

describe('isTenantTicketAssignee (the /partner rule: the tenant’s own eligible staff only)', () => {
  it('admits active support, admin and agent members of THIS tenant', () => {
    for (const role of ['support', 'admin', 'agent'] as const) expect(isTenantTicketAssignee(mk({ role }), 'p1')).toBe(true);
  });
  it('refuses platform staff (who can see every tenant), other tenants, unknown, suspended and finance', () => {
    expect(isTenantTicketAssignee(mk({ partnerId: undefined }), 'p1')).toBe(false);
    expect(isTenantTicketAssignee(mk({ partnerId: 'p2' }), 'p1')).toBe(false);
    expect(isTenantTicketAssignee(null, 'p1')).toBe(false);
    expect(isTenantTicketAssignee(mk({ status: 'suspended' }), 'p1')).toBe(false);
    expect(isTenantTicketAssignee(mk({ role: 'finance' as Staff['role'] }), 'p1')).toBe(false);
  });
  it('refuses auto-provisioned test accounts', () => {
    expect(isTenantTicketAssignee(mk({ username: 'e2e-smoke-agent' }), 'p1')).toBe(false);
  });
  it('an empty tenant admits nobody (and never throws)', () => {
    expect(isTenantTicketAssignee(mk({ partnerId: '' }), '')).toBe(false);
  });
});

describe('tenantTicketAssignees (the /partner assign dropdown)', () => {
  it('lists only the tenant’s eligible staff, sorted by username', () => {
    const all = [
      mk({ username: 'zed', role: 'agent' }),
      mk({ username: 'amy', role: 'support' }),
      mk({ username: 'plat', partnerId: undefined }),
      mk({ username: 'other', partnerId: 'p2' }),
      mk({ username: 'fin', role: 'finance' as Staff['role'] }),
      mk({ username: 'gone', status: 'suspended' }),
    ];
    expect(tenantTicketAssignees(all, 'p1').map((s) => s.username)).toEqual(['amy', 'zed']);
  });
});
