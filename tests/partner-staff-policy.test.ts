/**
 * partner-demo R5 — the pure rules behind partner-managed staff. A partner
 * admin may add/remove staff ONLY in their own tenant; the tenant always comes
 * from the session, a client-supplied id is a selector that must match it.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveStaffTenant,
  mayRemove,
  isLastTenantAdmin,
  newStaffRecord,
  listTenantStaff,
  isReservedStaffUsername,
  feedActorLabel,
} from '@/lib/partner-staff-policy';
import { SUPPORT_DEFAULT_PERMISSIONS, type Staff } from '@/lib/types';

function staff(over: Partial<Staff>): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
    passwordHash: 'x',
    createdAt: '2026-05-27T00:00:00Z',
    ...over,
  };
}

const platform = staff({ username: 'ops' });
const acmeAdmin = staff({ username: 'acme-admin', partnerId: 'acme' });
const betaAdmin = staff({ username: 'beta-admin', partnerId: 'beta' });

describe('resolveStaffTenant', () => {
  it('a platform admin gets the selector', () => {
    expect(resolveStaffTenant(platform, 'acme')).toBe('acme');
  });
  it('a partner admin gets their own tenant only when the selector matches', () => {
    expect(resolveStaffTenant(acmeAdmin, 'acme')).toBe('acme');
    expect(resolveStaffTenant(acmeAdmin, 'beta')).toBeNull();
    expect(resolveStaffTenant(betaAdmin, 'acme')).toBeNull();
  });
  it('an empty or blank selector resolves to nothing, for every actor', () => {
    expect(resolveStaffTenant(platform, '')).toBeNull();
    expect(resolveStaffTenant(platform, '   ')).toBeNull();
    expect(resolveStaffTenant(acmeAdmin, '')).toBeNull();
  });
  it('agent and support actors resolve to nothing, even in their own tenant', () => {
    expect(resolveStaffTenant(staff({ role: 'agent', partnerId: 'acme' }), 'acme')).toBeNull();
    expect(resolveStaffTenant(staff({ role: 'support', partnerId: 'acme' }), 'acme')).toBeNull();
    expect(resolveStaffTenant(staff({ role: 'agent' }), 'acme')).toBeNull();
  });
  it('a malformed empty-string partnerId on the actor fails closed (never platform)', () => {
    expect(resolveStaffTenant(staff({ partnerId: '' }), 'acme')).toBeNull();
  });
});

describe('mayRemove', () => {
  const acmeAgent = staff({ username: 'acme-agent', role: 'agent', partnerId: 'acme' });
  it('a partner admin may remove a member of their own tenant', () => {
    expect(mayRemove(acmeAdmin, acmeAgent)).toBe(true);
    expect(mayRemove(acmeAdmin, staff({ username: 'acme-admin-2', partnerId: 'acme' }))).toBe(true);
  });
  it('never yourself', () => {
    expect(mayRemove(acmeAdmin, acmeAdmin)).toBe(false);
    expect(mayRemove(platform, platform)).toBe(false);
  });
  it('never another tenant\'s member', () => {
    expect(mayRemove(betaAdmin, acmeAgent)).toBe(false);
  });
  it('never a platform account, whoever asks', () => {
    expect(mayRemove(acmeAdmin, staff({ username: 'root' }))).toBe(false);
    expect(mayRemove(platform, staff({ username: 'root' }))).toBe(false);
  });
  it('a platform admin may remove any tenant member', () => {
    expect(mayRemove(platform, acmeAgent)).toBe(true);
  });
  it('a non-admin actor may remove nobody', () => {
    expect(mayRemove(staff({ username: 'a2', role: 'agent', partnerId: 'acme' }), acmeAgent)).toBe(false);
  });
});

describe('isLastTenantAdmin', () => {
  const a1 = staff({ username: 'a1', partnerId: 'acme' });
  const a2 = staff({ username: 'a2', partnerId: 'acme' });
  const agent = staff({ username: 'g', role: 'agent', partnerId: 'acme' });
  it('true for the only active admin of the tenant', () => {
    expect(isLastTenantAdmin(a1, [a1, agent, betaAdmin, platform])).toBe(true);
  });
  it('false when another active admin remains', () => {
    expect(isLastTenantAdmin(a1, [a1, a2, agent])).toBe(false);
  });
  it('a suspended peer admin does not count', () => {
    expect(isLastTenantAdmin(a1, [a1, { ...a2, status: 'suspended' }])).toBe(true);
  });
  it('false for a non-admin or a platform target', () => {
    expect(isLastTenantAdmin(agent, [agent])).toBe(false);
    expect(isLastTenantAdmin(platform, [platform])).toBe(false);
  });
});

describe('newStaffRecord', () => {
  const input = { username: 'n', name: 'N', passwordHash: 'h', createdAt: '2026-09-25T00:00:00Z' };
  it('always carries the resolved tenant, never undefined', () => {
    for (const role of ['admin', 'agent', 'support'] as const) {
      const r = newStaffRecord('acme', { ...input, role });
      expect(r.partnerId).toBe('acme');
      expect(r.role).toBe(role);
      expect(r.status).toBeUndefined();
    }
  });
  it('never money permissions, in any role', () => {
    expect(newStaffRecord('acme', { ...input, role: 'admin' }).permissions).toEqual({
      canCancel: false, canResend: false, canAssign: false, canRevealPii: false,
    });
    expect(newStaffRecord('acme', { ...input, role: 'support' }).permissions).toEqual({ ...SUPPORT_DEFAULT_PERMISSIONS });
  });
  it('refuses an empty tenant or an unknown role', () => {
    expect(() => newStaffRecord('', { ...input, role: 'agent' })).toThrow();
    expect(() => newStaffRecord('acme', { ...input, role: 'root' as never })).toThrow(/role/i);
  });
});

describe('listTenantStaff', () => {
  const all = [platform, acmeAdmin, betaAdmin, staff({ username: 'acme-agent', role: 'agent', partnerId: 'acme' })];
  it('a partner scope sees only its own tenant', () => {
    expect(listTenantStaff({ kind: 'partner', partnerId: 'beta' }, 'beta', all).map((s) => s.username)).toEqual(['beta-admin']);
  });
  it('a partner scope asking for another tenant gets nothing', () => {
    expect(listTenantStaff({ kind: 'partner', partnerId: 'beta' }, 'acme', all)).toEqual([]);
  });
  it('the platform scope sees the tenant it asks for, never platform accounts', () => {
    expect(listTenantStaff({ kind: 'platform' }, 'acme', all).map((s) => s.username)).toEqual(['acme-admin', 'acme-agent']);
  });
});

describe('isReservedStaffUsername', () => {
  it('the seed admin name is reserved when configured', () => {
    expect(isReservedStaffUsername('owner', 'owner')).toBe(true);
    expect(isReservedStaffUsername('someone', 'owner')).toBe(false);
    expect(isReservedStaffUsername('owner', '')).toBe(false);
  });
});

describe('feedActorLabel', () => {
  it('a partner-scoped actor is shown by name; anything else as SmartRemit', () => {
    expect(feedActorLabel({ actor: 'acme-admin', actorScope: 'partner' })).toBe('acme-admin');
    expect(feedActorLabel({ actor: 'ops', actorScope: 'platform' })).toBe('SmartRemit');
    expect(feedActorLabel({ actor: 'ops' })).toBe('SmartRemit');
  });
});
