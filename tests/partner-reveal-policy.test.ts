import { describe, it, expect } from 'vitest';
import {
  IDENTITY_REVEAL_FIELDS,
  DESTINATION_REVEAL_FIELDS,
  revealClassOf,
  revealDecision,
  revealCapabilities,
  revealViewer,
  type RevealViewer,
} from '@/lib/partner-reveal-policy';
import { KNOWN_PARTNER_ROLES, type PartnerRole } from '@/lib/partner-access';
import type { Staff } from '@/lib/types';

// Lost-features restore, review BL-1: ONE reveal rule for every /partner page and action.
//   identity    (names, phones, customer identity): admin + agent, enrolled 2FA, NO canRevealPii;
//   destination (the full payout account): the same, plus canRevealPii (admins always have it);
//   support and finance: never.
const v = (role: PartnerRole, mfaEnrolled: boolean, canRevealPii: boolean): RevealViewer => ({ role, mfaEnrolled, canRevealPii });

describe('revealDecision', () => {
  it('identity: admin and agent with enrolled 2FA, whatever the reveal flag', () => {
    for (const role of ['admin', 'agent'] as const) {
      for (const flag of [true, false]) expect(revealDecision(v(role, true, flag), 'identity'), `${role}/${flag}`).toEqual({ ok: true });
    }
  });
  it('destination: also needs the reveal permission', () => {
    expect(revealDecision(v('admin', true, true), 'destination')).toEqual({ ok: true });
    expect(revealDecision(v('agent', true, true), 'destination')).toEqual({ ok: true });
    expect(revealDecision(v('agent', true, false), 'destination')).toEqual({ ok: false, reason: 'permission' });
  });
  it('not enrolled in 2FA is refused for both classes', () => {
    for (const role of ['admin', 'agent'] as const) {
      expect(revealDecision(v(role, false, true), 'identity')).toEqual({ ok: false, reason: 'mfa' });
      expect(revealDecision(v(role, false, true), 'destination')).toEqual({ ok: false, reason: 'mfa' });
    }
  });
  it('a missing permission is reported before a missing enrolment (enrolling would not help)', () => {
    expect(revealDecision(v('agent', false, false), 'destination')).toEqual({ ok: false, reason: 'permission' });
  });
  it('support and finance never, even enrolled and flagged', () => {
    for (const role of ['support', 'finance'] as const) {
      for (const cls of ['identity', 'destination'] as const) {
        expect(revealDecision(v(role, true, true), cls), `${role}/${cls}`).toEqual({ ok: false, reason: 'role' });
      }
    }
  });
  it('an unknown role or class fails closed', () => {
    expect(revealDecision(v('root' as PartnerRole, true, true), 'identity')).toEqual({ ok: false, reason: 'role' });
    expect(revealDecision(v('admin', true, true), 'everything' as never).ok).toBe(false);
  });
});

describe('revealCapabilities (what a page may offer; it depends on the viewer only)', () => {
  it('matches revealDecision for every role, enrolment and flag', () => {
    for (const role of KNOWN_PARTNER_ROLES) {
      for (const mfa of [true, false]) {
        for (const flag of [true, false]) {
          const viewer = v(role, mfa, flag);
          expect(revealCapabilities(viewer)).toEqual({
            identity: revealDecision(viewer, 'identity').ok,
            destination: revealDecision(viewer, 'destination').ok,
          });
        }
      }
    }
  });
});

describe('revealViewer (from the session)', () => {
  const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
  const staff = (o: Partial<Staff>): Staff => ({
    username: 'u', name: 'U', role: 'agent', permissions: perms, passwordHash: 'x', createdAt: '2026-01-01T00:00:00.000Z', partnerId: 'pa', ...o,
  });
  it('an admin always holds the reveal permission (hasPermission), an agent only with the flag, finance never', () => {
    expect(revealViewer({ role: 'admin', staff: staff({ role: 'admin' }) }, true)).toEqual(v('admin', true, true));
    expect(revealViewer({ role: 'agent', staff: staff({}) }, true)).toEqual(v('agent', true, false));
    expect(revealViewer({ role: 'agent', staff: staff({ permissions: { ...perms, canRevealPii: true } }) }, false)).toEqual(v('agent', false, true));
    expect(revealViewer({ role: 'finance', staff: staff({ role: 'finance', permissions: { ...perms, canRevealPii: true } }) }, true).canRevealPii).toBe(false);
  });
});

describe('field classes', () => {
  it('the full payout account is the only destination field', () => {
    expect([...DESTINATION_REVEAL_FIELDS]).toEqual(['payout_destination']);
    expect(revealClassOf('payout_destination')).toBe('destination');
  });
  it('sender, recipient and customer identity fields are identity', () => {
    for (const f of ['full_name', 'phone', 'date_of_birth', 'nationality', 'residential_address', 'recipient_name', 'recipient_phone']) {
      expect(IDENTITY_REVEAL_FIELDS, f).toContain(f);
      expect(revealClassOf(f), f).toBe('identity');
    }
  });
  it('anything else has no class (refused)', () => {
    for (const f of ['gov_id_number', 'email', '', 'payout_destination ', '__proto__', 'toString', null, 7]) {
      expect(revealClassOf(f as string), String(f)).toBeNull();
    }
  });
  it('the lists are frozen and disjoint', () => {
    expect(Object.isFrozen(IDENTITY_REVEAL_FIELDS)).toBe(true);
    expect(Object.isFrozen(DESTINATION_REVEAL_FIELDS)).toBe(true);
    for (const f of DESTINATION_REVEAL_FIELDS) expect(IDENTITY_REVEAL_FIELDS as readonly string[]).not.toContain(f);
  });
});
