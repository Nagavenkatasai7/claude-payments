import { describe, it, expect } from 'vitest';
import {
  buildInviteEmail,
  inviteResendDedupeKey,
  parseEmailDedupeKey,
  deriveInviteEmailStatus,
  INVITE_LINK_PLACEHOLDER,
} from '@/lib/partner-invite-email';

// Program-Fix 39: the partner-invite email helpers (pure).

describe('buildInviteEmail', () => {
  it('is the exact invite body the landing form has always sent, with the sealed-link placeholder', () => {
    const e = buildInviteEmail();
    expect(e.subject).toBe('Complete your SmartRemit partner application');
    expect(e.text).toBe(
      `Hi,\n\n` +
        `Thanks for your interest in partnering with SmartRemit. Please complete your detailed application here:\n\n` +
        `{{apply_link}}\n\n` +
        `This secure link is unique to you and expires in 30 days.\n\n` +
        `— The SmartRemit team`,
    );
    expect(INVITE_LINK_PLACEHOLDER).toBe('apply_link');
  });
});

describe('inviteResendDedupeKey', () => {
  it('is partner_app_invite:<id>:r<first 12 hex of the token hash>', () => {
    expect(inviteResendDedupeKey('preq_abc', 'a1b2c3d4e5f60718293a4b5c')).toBe('partner_app_invite:preq_abc:ra1b2c3d4e5f6');
  });
});

describe('parseEmailDedupeKey', () => {
  it('lead alert key → preq subject', () => {
    expect(parseEmailDedupeKey('preq:preq_abc')).toEqual({ prefix: 'preq', subjectId: 'preq_abc' });
  });
  it('original invite key → preq subject', () => {
    expect(parseEmailDedupeKey('partner_app_invite:preq_abc')).toEqual({ prefix: 'partner_app_invite', subjectId: 'preq_abc' });
  });
  it('resend key → same preq subject (the :r<…> suffix is stripped)', () => {
    expect(parseEmailDedupeKey('partner_app_invite:preq_abc:ra1b2c3d4e5f6')).toEqual({
      prefix: 'partner_app_invite',
      subjectId: 'preq_abc',
    });
  });
  it('null / unknown / malformed keys → no subject', () => {
    expect(parseEmailDedupeKey(null)).toEqual({ prefix: null, subjectId: null });
    expect(parseEmailDedupeKey('reply:12')).toEqual({ prefix: null, subjectId: null });
    expect(parseEmailDedupeKey('preq:')).toEqual({ prefix: 'preq', subjectId: null });
    expect(parseEmailDedupeKey('partner_app_invite:not-a-preq')).toEqual({ prefix: 'partner_app_invite', subjectId: null });
  });
});

describe('deriveInviteEmailStatus', () => {
  it('no invite row → unknown', () => {
    expect(deriveInviteEmailStatus(null, [])).toBe('unknown');
  });
  it('done row with no skip audit for it → sent', () => {
    expect(deriveInviteEmailStatus({ id: 7, status: 'done' }, [])).toBe('sent');
  });
  it('done row whose id a skip audit references → skipped', () => {
    expect(deriveInviteEmailStatus({ id: 7, status: 'done' }, [{ outboxId: 7 }])).toBe('skipped');
  });
  it('a skip audit for an OLDER row does not taint the newest one', () => {
    expect(deriveInviteEmailStatus({ id: 9, status: 'done' }, [{ outboxId: 7 }])).toBe('sent');
  });
  it('pending / processing / failed → queued; dead → failed', () => {
    expect(deriveInviteEmailStatus({ id: 1, status: 'pending' }, [])).toBe('queued');
    expect(deriveInviteEmailStatus({ id: 1, status: 'processing' }, [])).toBe('queued');
    expect(deriveInviteEmailStatus({ id: 1, status: 'failed' }, [])).toBe('queued');
    expect(deriveInviteEmailStatus({ id: 1, status: 'dead' }, [])).toBe('failed');
  });
});
