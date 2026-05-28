import { describe, it, expect } from 'vitest';
import { scopeOf, canSee } from '@/lib/staff-scope';
import type { Staff } from '@/lib/types';

function staff(partnerId?: string): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt: '2026-05-27T00:00:00Z',
    partnerId,
  };
}

describe('scopeOf', () => {
  it('returns platform scope when staff has no partnerId', () => {
    expect(scopeOf(staff(undefined))).toEqual({ kind: 'platform' });
  });

  it('returns partner scope when staff has a partnerId', () => {
    expect(scopeOf(staff('acme'))).toEqual({ kind: 'partner', partnerId: 'acme' });
  });
});

describe('canSee', () => {
  it('platform scope sees any partnerId', () => {
    expect(canSee({ kind: 'platform' }, 'any')).toBe(true);
    expect(canSee({ kind: 'platform' }, 'default')).toBe(true);
  });

  it('partner scope sees only its own partnerId', () => {
    const scope = { kind: 'partner' as const, partnerId: 'acme' };
    expect(canSee(scope, 'acme')).toBe(true);
    expect(canSee(scope, 'other')).toBe(false);
  });
});
