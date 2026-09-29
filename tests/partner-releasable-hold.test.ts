import { describe, it, expect } from 'vitest';
import {
  isPartnerReleasableHold,
  LARGE_AMOUNT_REASON,
  VELOCITY_REASON,
  EDD_REQUIRED_REASON,
  SCREENING_REASONS,
  POSSIBLE_MATCH_REASON,
  PARTNER_RELEASABLE_REASONS,
} from '@/lib/compliance-config';
import { screenTransfer } from '@/lib/compliance';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { evaluateEddForTransfer } from '@/lib/tier-rules';
import { STAFF_REASON_MIN } from '@/lib/send-limits';
import { DEFAULT_REASON_MIN } from '@/lib/ui/confirm-reason';

// UI redesign M3-10, Task 10.1: the partner hold-release predicate. SPEC §3.3 + D7: KYC may be
// delegated, sanctions may not. A partner admin may release ONLY a delegated partner's KYC/EDD-class
// hold (owner answer O1, 2026-09-28: edd_required, large amount, velocity). Fails closed.

const delegated = { kycMode: 'delegated' };
const held = (reasons: unknown, o: Record<string, unknown> = {}) => ({
  status: 'in_review',
  complianceStatus: 'flagged',
  complianceReasons: reasons as string[],
  ...o,
});

describe('isPartnerReleasableHold', () => {
  it('allows only a delegated partner’s EDD-class hold', () => {
    expect(isPartnerReleasableHold(held([LARGE_AMOUNT_REASON]), delegated)).toBe(true);
    expect(isPartnerReleasableHold(held([VELOCITY_REASON]), delegated)).toBe(true);
    expect(isPartnerReleasableHold(held([LARGE_AMOUNT_REASON, VELOCITY_REASON]), delegated)).toBe(true);
    expect(isPartnerReleasableHold(held([EDD_REQUIRED_REASON, LARGE_AMOUNT_REASON]), delegated)).toBe(true);
  });

  it.each(SCREENING_REASONS)('SANCTIONS/SCREENING reason %j is never partner-releasable (even mixed)', (r) => {
    expect(isPartnerReleasableHold(held([r]), delegated)).toBe(false);
    expect(isPartnerReleasableHold(held([LARGE_AMOUNT_REASON, r]), delegated)).toBe(false);
    expect(isPartnerReleasableHold(held([EDD_REQUIRED_REASON, r]), delegated)).toBe(false);
  });

  it('no screening reason is ever in the allowlist (structural: sanctions can never be delegated)', () => {
    for (const r of SCREENING_REASONS) expect(PARTNER_RELEASABLE_REASONS).not.toContain(r);
    expect(PARTNER_RELEASABLE_REASONS).not.toContain(AML_HOLD_REASON);
  });

  it('the allowlist is frozen (no runtime widening)', () => {
    expect(Object.isFrozen(PARTNER_RELEASABLE_REASONS)).toBe(true);
  });

  it('AML hold, unknown reasons, empty/malformed reasons: refused', () => {
    for (const r of [[AML_HOLD_REASON], ['Something new.'], [], null, undefined, 'x', [42], ['large transfer amount.']]) {
      expect(isPartnerReleasableHold(held(r), delegated)).toBe(false);
    }
  });

  it('kycMode ours/unset/unknown/missing partner: refused', () => {
    for (const o of [{ kycMode: 'ours' }, { kycMode: 'Delegated' }, { kycMode: null }, {}, null, undefined]) {
      expect(isPartnerReleasableHold(held([LARGE_AMOUNT_REASON]), o)).toBe(false);
    }
  });

  it('not in_review, or compliance blocked: refused', () => {
    for (const status of ['awaiting_payment', 'paid', 'delivered', 'cancelled', 'blocked']) {
      expect(isPartnerReleasableHold(held([LARGE_AMOUNT_REASON], { status }), delegated)).toBe(false);
    }
    expect(isPartnerReleasableHold(held([LARGE_AMOUNT_REASON], { complianceStatus: 'blocked' }), delegated)).toBe(false);
  });

  it('edd_required (tier-rules.ts:119) follows the O1 answer (owner 2026-09-28: releasable); mixed with AML: refused', () => {
    expect(PARTNER_RELEASABLE_REASONS).toContain('edd_required');
    expect(isPartnerReleasableHold(held(['edd_required']), delegated)).toBe(PARTNER_RELEASABLE_REASONS.includes('edd_required'));
    expect(isPartnerReleasableHold(held(['edd_required', AML_HOLD_REASON]), delegated)).toBe(false);
  });

  it('the reason strings are unchanged (stored rows keep matching)', () => {
    expect(evaluateEddForTransfer({ monthUsedCents: 10_000_000, requestedCents: 100, eddFieldsPresent: false }).flagReason).toBe(EDD_REQUIRED_REASON);
    expect(EDD_REQUIRED_REASON).toBe('edd_required');
    expect(LARGE_AMOUNT_REASON).toBe('Large transfer amount.');
    expect(VELOCITY_REASON).toBe('High transfer velocity.');
    expect(POSSIBLE_MATCH_REASON).toBe('Name screening needs manual review.');
  });

  it('screenTransfer still emits exactly the pinned strings for a large, high-velocity send', async () => {
    const r = await screenTransfer({ recipientName: 'Priya Sharma', senderName: 'Alex Morgan', amountUsd: 5000, transfersToday: 50 });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toEqual([LARGE_AMOUNT_REASON, VELOCITY_REASON]);
  });

  it('the server reason minimum equals the ConfirmDialog minimum (one rule, client + server)', () => {
    expect(STAFF_REASON_MIN).toBe(DEFAULT_REASON_MIN);
  });
});
