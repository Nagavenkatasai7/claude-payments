import { describe, it, expect } from 'vitest';
import { hasPermission } from '@/lib/permissions';
import type { Staff } from '@/lib/types';

function make(role: 'admin' | 'agent', perms: Partial<Staff['permissions']>): Staff {
  return {
    username: 'u',
    name: 'U',
    role,
    permissions: {
      canCancel: false,
      canResend: false,
      canAssign: false,
      ...perms,
    },
    passwordHash: 'x',
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('hasPermission', () => {
  it('admin has every permission', () => {
    const admin = make('admin', {});
    expect(hasPermission(admin, 'canCancel')).toBe(true);
    expect(hasPermission(admin, 'canResend')).toBe(true);
    expect(hasPermission(admin, 'canAssign')).toBe(true);
  });

  it('agent has only the permissions granted', () => {
    const agent = make('agent', { canResend: true });
    expect(hasPermission(agent, 'canResend')).toBe(true);
    expect(hasPermission(agent, 'canCancel')).toBe(false);
    expect(hasPermission(agent, 'canAssign')).toBe(false);
  });
});
