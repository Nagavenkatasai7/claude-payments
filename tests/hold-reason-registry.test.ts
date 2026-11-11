import { describe, it, expect } from 'vitest';
import * as cfg from '@/lib/compliance-config';
import {
  HOLD_REASONS,
  SCREENING_REASONS,
  PARTNER_RELEASABLE_REASONS,
  POSSIBLE_MATCH_REASON,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
  SENDER_IDENTITY_MISSING_REASON,
  SENDER_SCREENING_REASON,
  RECIPIENT_IDENTITY_MISSING_REASON,
  LARGE_AMOUNT_REASON,
  VELOCITY_REASON,
  EDD_REQUIRED_REASON,
  AML_HOLD_REASON,
  CUSTOMER_SCREENING_FLAGS,
  holdReleasableBy,
  isRecipientIdentityHold,
  isRescreenOnlyHold,
  isScreeningHold,
  senderScreeningHoldActive,
} from '@/lib/compliance-config';
import * as complianceReexports from '@/lib/compliance';
import { AML_HOLD_REASON as AML_FROM_AML_HOLD } from '@/lib/aml-hold';
import { FIXED_REPLIES } from '@/lib/hold-replies';
import { holdReasonKeys } from '@/lib/partner-transfers';
import { HOLD_REASON_CODES } from '@/lib/aml-explain-ai';
import { canReleaseHeld } from '@/lib/dashboard-ops';
import { t } from '@/lib/i18n';

// Fix pack 2 (R04, R06): ONE registry of every stored hold reason: its class,
// who may release it, and the customer copy. The older lists are derived.

describe('HOLD_REASONS registry', () => {
  it('pins every entry (class, releasableBy, customerCopyKey) and every string', () => {
    expect(HOLD_REASONS).toEqual({
      'Name screening needs manual review.': { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
      'Screening list unavailable; needs manual review.': { class: 'screening', releasableBy: 'rescreen', customerCopyKey: 'hold' },
      'Recipient is on the compliance watchlist.': { class: 'screening', releasableBy: 'platform', customerCopyKey: 'block' },
      'Sender is on the compliance watchlist.': { class: 'screening', releasableBy: 'platform', customerCopyKey: 'block' },
      'Sender identity missing.': { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
      'Sender screening needs manual review.': { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
      'Recipient identity missing.': { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
      'Large transfer amount.': { class: 'kyc', releasableBy: 'partner', customerCopyKey: 'hold' },
      'High transfer velocity.': { class: 'kyc', releasableBy: 'partner', customerCopyKey: 'hold' },
      edd_required: { class: 'kyc', releasableBy: 'partner', customerCopyKey: 'hold' },
      'Additional review required.': { class: 'aml', releasableBy: 'platform', customerCopyKey: 'hold' },
    });
    expect(POSSIBLE_MATCH_REASON).toBe('Name screening needs manual review.');
    expect(RECIPIENT_WATCHLIST_REASON).toBe('Recipient is on the compliance watchlist.');
    expect(SENDER_WATCHLIST_REASON).toBe('Sender is on the compliance watchlist.');
    expect(SENDER_IDENTITY_MISSING_REASON).toBe('Sender identity missing.');
    expect(SENDER_SCREENING_REASON).toBe('Sender screening needs manual review.');
    expect(RECIPIENT_IDENTITY_MISSING_REASON).toBe('Recipient identity missing.');
    expect(LARGE_AMOUNT_REASON).toBe('Large transfer amount.');
    expect(VELOCITY_REASON).toBe('High transfer velocity.');
    expect(EDD_REQUIRED_REASON).toBe('edd_required');
    expect(AML_HOLD_REASON).toBe('Additional review required.');
    expect(CUSTOMER_SCREENING_FLAGS).toEqual({ watchlistHit: 'platform', pepHit: 'platform' });
  });

  it('SCREENING_REASONS and PARTNER_RELEASABLE_REASONS are derived from the registry; PARTNER_RELEASABLE_REASONS is frozen', () => {
    const entries = Object.entries(HOLD_REASONS);
    expect([...SCREENING_REASONS].sort()).toEqual(entries.filter(([, e]) => e.class === 'screening').map(([k]) => k).sort());
    expect([...PARTNER_RELEASABLE_REASONS].sort()).toEqual(
      entries.filter(([, e]) => e.releasableBy === 'partner').map(([k]) => k).sort(),
    );
    expect([...PARTNER_RELEASABLE_REASONS].sort()).toEqual([LARGE_AMOUNT_REASON, VELOCITY_REASON, EDD_REQUIRED_REASON].sort());
    expect(Object.isFrozen(PARTNER_RELEASABLE_REASONS)).toBe(true);
    expect(Object.isFrozen(HOLD_REASONS)).toBe(true);
  });

  it('LIST_UNAVAILABLE_REASON is rescreen and its string is unchanged', () => {
    expect(LIST_UNAVAILABLE_REASON).toBe('Screening list unavailable; needs manual review.');
    expect(HOLD_REASONS[LIST_UNAVAILABLE_REASON]!.releasableBy).toBe('rescreen');
  });

  it('every customerCopyKey is a key of FIXED_REPLIES', () => {
    for (const e of Object.values(HOLD_REASONS)) expect(Object.keys(FIXED_REPLIES)).toContain(e.customerCopyKey);
  });

  it('every reason has a staff label (partner-transfers, aml-explain-ai)', () => {
    for (const r of Object.keys(HOLD_REASONS)) {
      expect(holdReasonKeys([r]), r).not.toEqual(['partner.transfers.reason.other']);
      expect(Object.hasOwn(HOLD_REASON_CODES, r), r).toBe(true);
    }
    expect(holdReasonKeys([SENDER_SCREENING_REASON])).toEqual(['partner.transfers.reason.screening']);
    expect(HOLD_REASON_CODES[SENDER_SCREENING_REASON]).toBe('screening');
  });

  // Pack 4 T12 (R03, C19): a real-money b2c transfer with no account-holder name on file.
  it('the recipient-identity reason is platform-only, never partner-releasable, and has its own staff labels', () => {
    const r = RECIPIENT_IDENTITY_MISSING_REASON;
    expect(holdReleasableBy([r])).toBe('platform');
    expect(holdReleasableBy([LARGE_AMOUNT_REASON, r])).toBe('platform');
    expect(PARTNER_RELEASABLE_REASONS).not.toContain(r);
    expect(isScreeningHold({ complianceReasons: [r] })).toBe(true);
    expect(holdReasonKeys([r])).toEqual(['partner.transfers.reason.recipientIdentity']);
    expect(HOLD_REASON_CODES[r]).toBe('recipient_identity_missing');
    expect(t('partner.transfers.reason.recipientIdentity')).toBe('Recipient identity missing');
  });

  // Pack 4 review R2 (I5): the staff pages say a recipient-identity hold is never released.
  it('isRecipientIdentityHold: true when the reasons carry the identity reason, else false (null-safe)', () => {
    expect(isRecipientIdentityHold({ complianceReasons: [RECIPIENT_IDENTITY_MISSING_REASON] })).toBe(true);
    expect(isRecipientIdentityHold({ complianceReasons: [LARGE_AMOUNT_REASON, RECIPIENT_IDENTITY_MISSING_REASON] })).toBe(true);
    expect(isRecipientIdentityHold({ complianceReasons: [LARGE_AMOUNT_REASON] })).toBe(false);
    expect(isRecipientIdentityHold({ complianceReasons: [] })).toBe(false);
    expect(isRecipientIdentityHold({ complianceReasons: null })).toBe(false);
    expect(isRecipientIdentityHold({})).toBe(false);
  });

  it('compliance.ts re-exports the new registry names', () => {
    expect(complianceReexports.SENDER_SCREENING_REASON).toBe(SENDER_SCREENING_REASON);
    expect(complianceReexports.RECIPIENT_IDENTITY_MISSING_REASON).toBe(RECIPIENT_IDENTITY_MISSING_REASON);
    expect(complianceReexports.HOLD_REASONS).toBe(HOLD_REASONS);
    expect(complianceReexports.holdReleasableBy).toBe(holdReleasableBy);
    expect(complianceReexports.isRescreenOnlyHold).toBe(isRescreenOnlyHold);
  });
});

describe('holdReleasableBy', () => {
  it('rescreen beats platform beats partner; empty/unknown -> platform', () => {
    expect(holdReleasableBy([LARGE_AMOUNT_REASON, VELOCITY_REASON])).toBe('partner');
    expect(holdReleasableBy([EDD_REQUIRED_REASON])).toBe('partner');
    expect(holdReleasableBy([LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON])).toBe('platform');
    expect(holdReleasableBy([LARGE_AMOUNT_REASON, AML_HOLD_REASON])).toBe('platform');
    expect(holdReleasableBy([LIST_UNAVAILABLE_REASON])).toBe('rescreen');
    expect(holdReleasableBy([LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON, LARGE_AMOUNT_REASON])).toBe('rescreen');
    expect(holdReleasableBy([LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON])).toBe('rescreen');
    expect(holdReleasableBy([])).toBe('platform');
    expect(holdReleasableBy(null)).toBe('platform');
    expect(holdReleasableBy(undefined)).toBe('platform');
    expect(holdReleasableBy(['free text from somewhere'])).toBe('platform');
    expect(holdReleasableBy([LARGE_AMOUNT_REASON, 'free text'])).toBe('platform');
    expect(holdReleasableBy(['toString'])).toBe('platform');
    expect(holdReleasableBy([42 as unknown as string])).toBe('platform');
  });
});

describe('isRescreenOnlyHold', () => {
  it('alone, mixed, none', () => {
    expect(isRescreenOnlyHold({ complianceReasons: [LIST_UNAVAILABLE_REASON] })).toBe(true);
    expect(isRescreenOnlyHold({ complianceReasons: [LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON, VELOCITY_REASON] })).toBe(true);
    expect(isRescreenOnlyHold({ complianceReasons: [POSSIBLE_MATCH_REASON] })).toBe(false);
    expect(isRescreenOnlyHold({ complianceReasons: [] })).toBe(false);
    expect(isRescreenOnlyHold({ complianceReasons: null })).toBe(false);
    expect(isRescreenOnlyHold({})).toBe(false);
  });
});

describe('senderScreeningHoldActive', () => {
  const now = Date.now();
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

  it('table', () => {
    // null row
    expect(senderScreeningHoldActive(null)).toBe(false);
    expect(senderScreeningHoldActive(undefined)).toBe(false);
    // no hit and no flaggedAt
    expect(senderScreeningHoldActive({ watchlistHit: false, pepHit: false })).toBe(false);
    expect(senderScreeningHoldActive({ watchlistHit: null, pepHit: null, screeningFlaggedAt: null, screeningClearedAt: at(5) })).toBe(false);
    // hit, no times
    expect(senderScreeningHoldActive({ watchlistHit: true })).toBe(true);
    expect(senderScreeningHoldActive({ pepHit: true, screeningFlaggedAt: null, screeningClearedAt: null })).toBe(true);
    // cleared after flag
    expect(senderScreeningHoldActive({ pepHit: true, screeningFlaggedAt: at(60), screeningClearedAt: at(30) })).toBe(false);
    expect(senderScreeningHoldActive({ pepHit: true, screeningFlaggedAt: new Date(now - 3_600_000), screeningClearedAt: new Date(now - 60_000) })).toBe(false);
    // re-flagged after clear
    expect(senderScreeningHoldActive({ watchlistHit: true, screeningFlaggedAt: at(10), screeningClearedAt: at(30) })).toBe(true);
    // tie = held
    const t = at(15);
    expect(senderScreeningHoldActive({ watchlistHit: true, screeningFlaggedAt: t, screeningClearedAt: t })).toBe(true);
    // hit, flaggedAt null, cleared
    expect(senderScreeningHoldActive({ watchlistHit: true, screeningFlaggedAt: null, screeningClearedAt: at(5) })).toBe(false);
    // booleans lost by a stale upsert (null) but flaggedAt set, no clear
    expect(senderScreeningHoldActive({ watchlistHit: null, pepHit: null, screeningFlaggedAt: at(5), screeningClearedAt: null })).toBe(true);
  });
});

describe('AML_HOLD_REASON home', () => {
  it("AML_HOLD_REASON re-exported by aml-hold equals compliance-config's", () => {
    expect(AML_FROM_AML_HOLD).toBe(cfg.AML_HOLD_REASON);
  });
});

// Fix pack 2 T4 (R02): the staff release gate follows the registry: a
// 'rescreen' reason is never released by a person, platform staff included.
describe('canReleaseHeld and the registry (fix pack 2 T4)', () => {
  it('canReleaseHeld agrees with isRescreenOnlyHold for every registry reason', () => {
    for (const reason of Object.keys(HOLD_REASONS)) {
      const t = { status: 'in_review' as const, complianceStatus: 'flagged' as const, complianceReasons: [reason] };
      expect(canReleaseHeld({ kind: 'platform' }, { kycMode: 'ours' }, t, null), reason).toBe(!isRescreenOnlyHold(t));
      expect(canReleaseHeld({ kind: 'platform' }, { kycMode: 'ours' }, { ...t, complianceReasons: [LARGE_AMOUNT_REASON, reason] }, null), reason)
        .toBe(!isRescreenOnlyHold({ complianceReasons: [LARGE_AMOUNT_REASON, reason] }));
    }
    expect(Object.keys(HOLD_REASONS).some((r) => isRescreenOnlyHold({ complianceReasons: [r] }))).toBe(true);
  });
});
