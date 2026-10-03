import { describe, it, expect } from 'vitest';
import {
  isTenantTransferAssignee,
  platformAssigneeOptions,
  tenantTransferAssignees,
  transferAssigneeRefusal,
} from '@/lib/transfer-assignable';
import type { Staff } from '@/lib/types';

// Lost-features restore p1 A2 and the dead-end fix: who may be given a transfer. Only admin and
// agent can open transfers on either dashboard (support is bounced, finance is not a worker), so
// an assignment to anyone else is a dead end. /partner picks only its own staff; the platform
// picker lists SmartRemit staff plus the transfer's own tenant.

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const s = (username: string, o: Partial<Staff> = {}): Staff =>
  ({ username, name: username.toUpperCase(), role: 'agent', permissions: perms, passwordHash: 'h', createdAt: '', ...o }) as Staff;

describe('transferAssigneeRefusal (both dashboards)', () => {
  it('each refusal in order', () => {
    expect(transferAssigneeRefusal(null, 'pa')).toBe('unknown');
    expect(transferAssigneeRefusal(s('x', { partnerId: 'pa', status: 'suspended' }), 'pa')).toBe('inactive');
    expect(transferAssigneeRefusal(s('x', { partnerId: 'pb' }), 'pa')).toBe('scope');
    expect(transferAssigneeRefusal(s('x', { partnerId: 'pa', role: 'support' }), 'pa')).toBe('role');
    expect(transferAssigneeRefusal(s('x', { partnerId: 'pa', role: 'finance' }), 'pa')).toBe('role');
    expect(transferAssigneeRefusal(s('x', { role: 'support' }), 'pa')).toBe('role');
  });
  it('admin and agent of the tenant, or of the platform, are assignable', () => {
    expect(transferAssigneeRefusal(s('x', { partnerId: 'pa' }), 'pa')).toBeNull();
    expect(transferAssigneeRefusal(s('x', { partnerId: 'pa', role: 'admin' }), 'pa')).toBeNull();
    expect(transferAssigneeRefusal(s('x', { role: 'admin' }), 'pa')).toBeNull();
  });
});

describe('isTenantTransferAssignee (/partner)', () => {
  it('a member of the tenant only: never a SmartRemit account, another tenant or a test account', () => {
    expect(isTenantTransferAssignee(s('a', { partnerId: 'pa' }), 'pa')).toBe(true);
    expect(isTenantTransferAssignee(s('plat', { role: 'admin' }), 'pa')).toBe(false);
    expect(isTenantTransferAssignee(s('b', { partnerId: 'pb' }), 'pa')).toBe(false);
    expect(isTenantTransferAssignee(s('e2e-smoke-agent', { partnerId: 'pa' }), 'pa')).toBe(false);
    expect(isTenantTransferAssignee(s('sup', { partnerId: 'pa', role: 'support' }), 'pa')).toBe(false);
    expect(isTenantTransferAssignee(s('a', { partnerId: 'pa' }), '')).toBe(false);
    expect(isTenantTransferAssignee(null, 'pa')).toBe(false);
  });
  it('tenantTransferAssignees: sorted, filtered', () => {
    const all = [s('zed', { partnerId: 'pa' }), s('amy', { partnerId: 'pa', role: 'admin' }), s('fin', { partnerId: 'pa', role: 'finance' }), s('bob', { partnerId: 'pb' }), s('plat')];
    expect(tenantTransferAssignees(all, 'pa').map((x) => x.username)).toEqual(['amy', 'zed']);
  });
});

describe('platformAssigneeOptions (the SmartRemit picker)', () => {
  it('SmartRemit staff in one group, each tenant\'s staff under its own tenant only; names and usernames only', () => {
    const all = [
      s('plat-admin', { role: 'admin' }),
      s('plat-support', { role: 'support' }),
      s('pa-agent', { partnerId: 'pa' }),
      s('pa-off', { partnerId: 'pa', status: 'suspended' }),
      s('pb-admin', { partnerId: 'pb', role: 'admin' }),
      s('pb-fin', { partnerId: 'pb', role: 'finance' }),
      s('e2e-smoke-x', { partnerId: 'pb' }),
    ];
    const o = platformAssigneeOptions(all);
    expect(o.platform).toEqual([{ username: 'plat-admin', name: 'PLAT-ADMIN' }]);
    expect(o.byTenant).toEqual({ pa: [{ username: 'pa-agent', name: 'PA-AGENT' }], pb: [{ username: 'pb-admin', name: 'PB-ADMIN' }] });
    for (const opt of [...o.platform, ...Object.values(o.byTenant).flat()]) expect(Object.keys(opt).sort()).toEqual(['name', 'username']);
  });
});
