import { describe, it, expect } from 'vitest';
import {
  decidePartnerAccess,
  PARTNER_ANY,
  PARTNER_ADMIN,
  PARTNER_OPS,
  PARTNER_MONEY_READ,
  PARTNER_TICKETS,
  PARTNER_REPORTS,
  KNOWN_PARTNER_ROLES,
} from '@/lib/partner-access';
import type { Staff } from '@/lib/types';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const mk = (o: Partial<Staff>): Staff => ({
  username: 'u1',
  name: 'U',
  role: 'admin',
  permissions: perms,
  passwordHash: 'x',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'pa',
  ...o,
});
const NO_MFA = { pending: false };
const ALL_POLICIES = [PARTNER_ANY, PARTNER_ADMIN, PARTNER_OPS, PARTNER_MONEY_READ, PARTNER_TICKETS, PARTNER_REPORTS];

describe('decidePartnerAccess (SPEC §3 gate, pure)', () => {
  it('anonymous → /login', () => {
    expect(decidePartnerAccess(null, PARTNER_ANY, NO_MFA)).toEqual({ ok: false, redirectTo: '/login' });
  });
  it('platform staff (no partnerId) → /admin-dashboard, for every policy and every legacy role', () => {
    for (const p of ALL_POLICIES) {
      for (const role of KNOWN_PARTNER_ROLES.filter((r) => r !== 'finance')) {
        expect(decidePartnerAccess(mk({ partnerId: undefined, role }), p, NO_MFA)).toEqual({
          ok: false,
          redirectTo: '/admin-dashboard',
        });
      }
    }
  });
  it('an empty-string partnerId never becomes platform (scopeOf throws) → /login', () => {
    expect(decidePartnerAccess(mk({ partnerId: '' }), PARTNER_ANY, NO_MFA)).toEqual({ ok: false, redirectTo: '/login' });
  });
  it('a suspended record → /login (defence in depth; getCurrentStaff already nulls it), platform included', () => {
    expect(decidePartnerAccess(mk({ status: 'suspended' }), PARTNER_ANY, NO_MFA)).toEqual({ ok: false, redirectTo: '/login' });
    expect(decidePartnerAccess(mk({ status: 'suspended', partnerId: undefined }), PARTNER_ANY, NO_MFA)).toEqual({
      ok: false,
      redirectTo: '/login',
    });
  });
  it('an unknown role string → /login (fail closed, never a guess), even with MFA pending', () => {
    for (const role of ['owner', 'FINANCE', 'ADMIN', '', 'superadmin']) {
      expect(decidePartnerAccess(mk({ role: role as Staff['role'] }), PARTNER_ANY, NO_MFA)).toEqual({
        ok: false,
        redirectTo: '/login',
      });
      expect(decidePartnerAccess(mk({ role: role as Staff['role'] }), PARTNER_ANY, { pending: true })).toEqual({
        ok: false,
        redirectTo: '/login',
      });
    }
  });
  it('a known role outside the policy → /partner (home allows every role, so no loop)', () => {
    expect(decidePartnerAccess(mk({ role: 'support' }), PARTNER_OPS, NO_MFA)).toEqual({ ok: false, redirectTo: '/partner' });
    expect(decidePartnerAccess(mk({ role: 'agent' }), PARTNER_ADMIN, NO_MFA)).toEqual({ ok: false, redirectTo: '/partner' });
    expect(decidePartnerAccess(mk({ role: 'support' }), PARTNER_MONEY_READ, NO_MFA)).toEqual({ ok: false, redirectTo: '/partner' });
    expect(decidePartnerAccess(mk({ role: 'agent' }), PARTNER_REPORTS, NO_MFA)).toEqual({ ok: false, redirectTo: '/partner' });
    expect(PARTNER_ANY.roles).toEqual(KNOWN_PARTNER_ROLES);
  });
  it('the role sets per preset (a set, not a rank)', () => {
    expect([...PARTNER_ANY.roles]).toEqual(['admin', 'agent', 'support', 'finance']);
    expect([...PARTNER_ADMIN.roles]).toEqual(['admin']);
    expect([...PARTNER_OPS.roles]).toEqual(['admin', 'agent']);
    expect([...PARTNER_MONEY_READ.roles]).toEqual(['admin', 'agent', 'finance']);
    expect([...PARTNER_TICKETS.roles]).toEqual(['admin', 'agent', 'support']);
    expect([...PARTNER_REPORTS.roles]).toEqual(['admin', 'finance']);
  });
  it('a platform-scoped finance record → /login (never the /partner ↔ /admin-dashboard loop)', () => {
    for (const p of ALL_POLICIES) {
      expect(decidePartnerAccess(mk({ partnerId: undefined, role: 'finance' }), p, NO_MFA)).toEqual({ ok: false, redirectTo: '/login' });
    }
  });
  it('M3-6: finance is admitted ONLY by PARTNER_ANY, PARTNER_MONEY_READ and PARTNER_REPORTS', () => {
    const f = mk({ role: 'finance', partnerId: 'pa' });
    for (const p of [PARTNER_ANY, PARTNER_MONEY_READ, PARTNER_REPORTS]) {
      expect(decidePartnerAccess(f, p, NO_MFA)).toMatchObject({ ok: true, ctx: { partnerId: 'pa', role: 'finance' } });
    }
    for (const p of [PARTNER_ADMIN, PARTNER_OPS, PARTNER_TICKETS]) {
      expect(decidePartnerAccess(f, p, NO_MFA)).toEqual({ ok: false, redirectTo: '/partner' });
    }
  });
  it('M3-6: a finance member with MFA pending is sent to enrol first', () => {
    expect(decidePartnerAccess(mk({ role: 'finance', partnerId: 'pa' }), PARTNER_MONEY_READ, { pending: true })).toEqual({
      ok: false,
      redirectTo: '/partner/security?enroll=1',
    });
  });
  it('presets are frozen (no caller can widen a policy at runtime)', () => {
    for (const p of ALL_POLICIES) {
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.roles)).toBe(true);
    }
    expect(Object.isFrozen(KNOWN_PARTNER_ROLES)).toBe(true);
  });
  it('pending MFA enrolment → /partner/security?enroll=1 unless skip', () => {
    expect(decidePartnerAccess(mk({}), PARTNER_ANY, { pending: true })).toEqual({
      ok: false,
      redirectTo: '/partner/security?enroll=1',
    });
    expect(decidePartnerAccess(mk({}), PARTNER_ANY, { pending: true, skip: true })).toMatchObject({ ok: true });
  });
  it('pending MFA wins over a role bounce (enrol first, then the role rule applies)', () => {
    expect(decidePartnerAccess(mk({ role: 'agent' }), PARTNER_ADMIN, { pending: true })).toEqual({
      ok: false,
      redirectTo: '/partner/security?enroll=1',
    });
  });
  it('allowed → ctx whose partnerId is the SESSION record’s, nothing else', () => {
    const s = mk({ role: 'support', partnerId: 'pa' });
    const d = decidePartnerAccess(s, PARTNER_TICKETS, NO_MFA);
    expect(d).toEqual({ ok: true, ctx: { partnerId: 'pa', username: 'u1', role: 'support', staff: s } });
  });
  it('every known role is admitted by PARTNER_ANY with its own tenant', () => {
    for (const role of KNOWN_PARTNER_ROLES) {
      expect(decidePartnerAccess(mk({ role, partnerId: 'pb' }), PARTNER_ANY, NO_MFA)).toMatchObject({
        ok: true,
        ctx: { partnerId: 'pb', role },
      });
    }
  });
  it('the decision takes no request input at all (signature pin: 3 params)', () => {
    expect(decidePartnerAccess.length).toBe(3);
  });
});
