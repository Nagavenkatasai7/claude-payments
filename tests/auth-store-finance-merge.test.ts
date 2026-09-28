import { describe, it, expect } from 'vitest';
import { mergeStaffRecords } from '@/lib/auth-store';
import { FINANCE_DEFAULT_PERMISSIONS, type Staff } from '@/lib/types';

// UI redesign M3-6: the Redis/ledger merge for the new 'finance' role. mergeRole itself is
// unchanged: admin vs finance -> finance (the lower role), agent/support vs finance ->
// incomparable -> suspended. A merged finance record always carries all-false permissions,
// whatever either store claims (like support).
const ALL_TRUE = { canCancel: true, canResend: true, canAssign: true, canRevealPii: true };
const mk = (o: Partial<Staff>): Staff => ({
  username: 'f1',
  name: 'F',
  role: 'admin',
  permissions: ALL_TRUE,
  passwordHash: 'h',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'pa',
  ...o,
});
const FIN = 'finance' as Staff['role'];

describe('mergeStaffRecords with finance', () => {
  it('(redis=finance, ledger=admin) → finance, all-false permissions, active', () => {
    const m = mergeStaffRecords(mk({ role: FIN }), mk({ role: 'admin' }), '');
    expect(m.role).toBe('finance');
    expect(m.permissions).toEqual(FINANCE_DEFAULT_PERMISSIONS);
    expect(m.status).toBeUndefined();
  });
  it('(redis=admin, ledger=finance) → finance, all-false permissions', () => {
    const m = mergeStaffRecords(mk({ role: 'admin' }), mk({ role: FIN }), '');
    expect(m.role).toBe('finance');
    expect(m.permissions).toEqual(FINANCE_DEFAULT_PERMISSIONS);
  });
  it('(finance, agent) and (agent, finance) → suspended (incomparable)', () => {
    expect(mergeStaffRecords(mk({ role: FIN }), mk({ role: 'agent' }), '').status).toBe('suspended');
    expect(mergeStaffRecords(mk({ role: 'agent' }), mk({ role: FIN }), '').status).toBe('suspended');
  });
  it('(finance, support) and (support, finance) → suspended (incomparable)', () => {
    expect(mergeStaffRecords(mk({ role: FIN }), mk({ role: 'support' }), '').status).toBe('suspended');
    expect(mergeStaffRecords(mk({ role: 'support' }), mk({ role: FIN }), '').status).toBe('suspended');
  });
  it('(finance, finance) → finance with all-false permissions even when both stores claim every permission', () => {
    const m = mergeStaffRecords(mk({ role: FIN }), mk({ role: FIN }), '');
    expect(m.role).toBe('finance');
    expect(m.permissions).toEqual(FINANCE_DEFAULT_PERMISSIONS);
    expect(m.permissions.canRevealPii).toBe(false);
  });
  it('the permissions object is a copy (a caller mutating it never widens the constant)', () => {
    const m = mergeStaffRecords(mk({ role: FIN }), mk({ role: FIN }), '');
    expect(m.permissions).not.toBe(FINANCE_DEFAULT_PERMISSIONS);
  });
  it('a finance row naming another tenant still fails closed (suspended)', () => {
    expect(mergeStaffRecords(mk({ role: FIN }), mk({ role: FIN, partnerId: 'pb' }), '').status).toBe('suspended');
  });
});
