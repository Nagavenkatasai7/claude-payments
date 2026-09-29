import { describe, it, expect } from 'vitest';
import { isTicketAssignable } from '@/lib/ticket-assignable';
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
