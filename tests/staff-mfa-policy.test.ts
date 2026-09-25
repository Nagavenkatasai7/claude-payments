/**
 * Program-Fix 17b — MFA enforcement is OPT-IN (STAFF_MFA_REQUIRED, default
 * off), platform admins only, and NEVER applies to the seed admin or a name in
 * STAFF_MFA_EXEMPT.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { env } from '@/lib/env';
import { mfaEnrolmentRequired } from '@/lib/staff-mfa-policy';
import type { Staff } from '@/lib/types';

const base: Staff = {
  username: 'ops',
  name: 'Ops',
  role: 'admin',
  permissions: { canCancel: false, canResend: false, canAssign: false },
  passwordHash: 'x',
  createdAt: '2026-05-27T00:00:00Z',
};

afterEach(() => {
  delete process.env.STAFF_MFA_REQUIRED;
  delete process.env.STAFF_MFA_EXEMPT;
});

describe('env getters', () => {
  it('STAFF_MFA_REQUIRED defaults to false; only "true" turns it on', () => {
    expect(env.staffMfaRequired).toBe(false);
    process.env.STAFF_MFA_REQUIRED = 'yes';
    expect(env.staffMfaRequired).toBe(false);
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(env.staffMfaRequired).toBe(true);
  });

  it('STAFF_MFA_EXEMPT is a trimmed comma list, empty by default', () => {
    expect(env.staffMfaExempt).toEqual([]);
    process.env.STAFF_MFA_EXEMPT = ' e2e-user , ,other ';
    expect(env.staffMfaExempt).toEqual(['e2e-user', 'other']);
  });
});

describe('mfaEnrolmentRequired', () => {
  it('flag off (default) → never required', () => {
    expect(mfaEnrolmentRequired(base)).toBe(false);
  });

  it('flag on → required for a platform admin', () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(mfaEnrolmentRequired(base)).toBe(true);
  });

  it('flag on → seed admin never required', () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(mfaEnrolmentRequired({ ...base, username: 'admin' })).toBe(false);
  });

  it('flag on → a same-named PARTNER account does not inherit the seed exemption', () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    // partner staff are out of scope for enforcement (fix 49) either way
    expect(mfaEnrolmentRequired({ ...base, username: 'admin', partnerId: 'p1' as Staff['partnerId'] })).toBe(false);
  });

  it('flag on → a name in STAFF_MFA_EXEMPT is not required', () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    process.env.STAFF_MFA_EXEMPT = 'e2e-user';
    expect(mfaEnrolmentRequired({ ...base, username: 'e2e-user' })).toBe(false);
    expect(mfaEnrolmentRequired(base)).toBe(true);
  });

  it('flag on → partner staff and non-admins are not in scope (fix 49)', () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(mfaEnrolmentRequired({ ...base, partnerId: 'p1' as Staff['partnerId'] })).toBe(false);
    expect(mfaEnrolmentRequired({ ...base, role: 'agent' })).toBe(false);
  });

  it('partner-demo R5: { partnerAdmins: true } also covers PARTNER admins, same flag and exemptions', () => {
    const partnerAdmin: Staff = { ...base, username: 'acme-admin', partnerId: 'acme' as Staff['partnerId'] };
    // flag off → never required, with or without the option
    expect(mfaEnrolmentRequired(partnerAdmin, { partnerAdmins: true })).toBe(false);
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(mfaEnrolmentRequired(partnerAdmin, { partnerAdmins: true })).toBe(true);
    expect(mfaEnrolmentRequired(partnerAdmin)).toBe(false); // default call unchanged
    expect(mfaEnrolmentRequired(base, { partnerAdmins: true })).toBe(true); // platform unchanged
    expect(mfaEnrolmentRequired({ ...partnerAdmin, role: 'agent' }, { partnerAdmins: true })).toBe(false);
    // a partner account named like the seed admin does not inherit the seed exemption
    expect(mfaEnrolmentRequired({ ...partnerAdmin, username: 'admin' }, { partnerAdmins: true })).toBe(true);
    process.env.STAFF_MFA_EXEMPT = 'acme-admin';
    expect(mfaEnrolmentRequired(partnerAdmin, { partnerAdmins: true })).toBe(false);
  });
});
