import { describe, it, expect } from 'vitest';
import {
  AML_DISPOSITIONS,
  AML_RULE_KEYS,
  amlRuleKey,
  isAmlDisposition,
  parseAmlAlertId,
  isKycQueueState,
  kycQueueCounts,
  partnerKycDecision,
  partnerMayRejectHold,
} from '@/lib/partner-reviews';
import {
  EDD_REQUIRED_REASON as EDD,
  LARGE_AMOUNT_REASON as LARGE,
  SCREENING_REASONS,
  VELOCITY_REASON as VELOCITY,
  isPartnerReleasableHold,
} from '@/lib/compliance-config';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { t } from '@/lib/i18n';
import type { Customer, KycReviewState, KycStatus } from '@/lib/types';

// Merge plan 2c (owner D3 / D4 / D5): the PURE rules behind /partner/reviews. A partner decides a
// customer's KYC only in delegated mode and only without a screening hit; a partner rejects a hold
// only when it could release it.

const delegated = { kycMode: 'delegated' as const };
const ours = { kycMode: 'ours' as const };
const cust = (o: Partial<Customer> = {}): Pick<Customer, 'partnerId' | 'kycStatus' | 'kycReviewState' | 'pepHit' | 'watchlistHit'> => ({
  partnerId: 'pa',
  kycStatus: 'pending',
  kycReviewState: 'pending_review',
  ...o,
});

describe('partnerKycDecision (D3)', () => {
  it('a delegated partner decides a queued customer through the Persona-review slug', () => {
    expect(partnerKycDecision(delegated, cust(), 'approve')).toEqual({ ok: true, slug: 'kyc.review.approve', source: 'persona_review' });
    expect(partnerKycDecision(delegated, cust({ kycReviewState: 'needs_review' }), 'reject')).toEqual({
      ok: true,
      slug: 'kyc.review.reject',
      source: 'persona_review',
    });
  });

  it('outside the queue the decision is a manual override', () => {
    expect(partnerKycDecision(delegated, cust({ kycReviewState: 'none', kycStatus: 'not_started' }), 'approve')).toEqual({
      ok: true,
      slug: 'kyc.manual_override.approve',
      source: 'manual',
    });
    expect(partnerKycDecision(delegated, cust({ kycReviewState: 'approved', kycStatus: 'verified' }), 'reject')).toEqual({
      ok: true,
      slug: 'kyc.manual_override.reject',
      source: 'manual',
    });
  });

  it('a no-op manual decision is refused (approve a verified/grandfathered customer, reject a rejected one)', () => {
    for (const s of ['verified', 'grandfathered'] as KycStatus[]) {
      expect(partnerKycDecision(delegated, cust({ kycReviewState: 'approved', kycStatus: s }), 'approve')).toEqual({ ok: false });
    }
    expect(partnerKycDecision(delegated, cust({ kycReviewState: 'rejected', kycStatus: 'rejected' }), 'reject')).toEqual({ ok: false });
  });

  it("refuses unless the owner's KYC mode is exactly 'delegated' (ours, missing, unknown)", () => {
    expect(partnerKycDecision(ours, cust(), 'approve')).toEqual({ ok: false });
    expect(partnerKycDecision(null, cust(), 'approve')).toEqual({ ok: false });
    expect(partnerKycDecision(undefined, cust(), 'approve')).toEqual({ ok: false });
    expect(partnerKycDecision({}, cust(), 'approve')).toEqual({ ok: false });
    expect(partnerKycDecision({ kycMode: 'DELEGATED' }, cust(), 'approve')).toEqual({ ok: false });
  });

  it('refuses a customer with a PEP or watchlist hit, whatever the decision or queue state', () => {
    for (const hit of [{ pepHit: true }, { watchlistHit: true }, { pepHit: true, watchlistHit: true }]) {
      for (const state of ['pending_review', 'needs_review', 'none', 'approved'] as KycReviewState[]) {
        for (const d of ['approve', 'reject'] as const) {
          expect(partnerKycDecision(delegated, cust({ ...hit, kycReviewState: state, kycStatus: 'pending' }), d)).toEqual({ ok: false });
        }
      }
    }
  });

  it('explicit false flags are not a hit', () => {
    expect(partnerKycDecision(delegated, cust({ pepHit: false, watchlistHit: false }), 'approve').ok).toBe(true);
  });

  it('refuses a missing customer and an unknown decision', () => {
    expect(partnerKycDecision(delegated, null, 'approve')).toEqual({ ok: false });
    expect(partnerKycDecision(delegated, cust(), 'override' as never)).toEqual({ ok: false });
    expect(partnerKycDecision(delegated, cust(), '' as never)).toEqual({ ok: false });
  });

  it('the refusal carries no reason (nothing that could tip off a screening hit)', () => {
    const ourMode = partnerKycDecision(ours, cust(), 'approve');
    const screening = partnerKycDecision(delegated, cust({ pepHit: true }), 'approve');
    expect(ourMode).toEqual(screening);
    expect(Object.keys(screening)).toEqual(['ok']);
  });
});

describe('isKycQueueState', () => {
  it('only pending_review and needs_review are awaiting a decision', () => {
    expect(isKycQueueState('pending_review')).toBe(true);
    expect(isKycQueueState('needs_review')).toBe(true);
    for (const s of ['none', 'inquiry_started', 'approved', 'rejected', undefined, null, 'x']) expect(isKycQueueState(s)).toBe(false);
  });
});

describe('partnerMayRejectHold (D4)', () => {
  const held = (reasons: readonly string[], o: Record<string, unknown> = {}) => ({
    status: 'in_review',
    complianceStatus: 'flagged',
    complianceReasons: reasons,
    ...o,
  });
  const clean = { pepHit: false, watchlistHit: false };

  it('mirrors isPartnerReleasableHold: a delegated KYC-class hold with a clean sender', () => {
    for (const r of [[LARGE], [VELOCITY], [EDD], [LARGE, VELOCITY]]) {
      expect(partnerMayRejectHold(held(r), delegated, clean)).toBe(true);
      expect(partnerMayRejectHold(held(r), delegated, clean)).toBe(isPartnerReleasableHold(held(r), delegated, clean));
    }
  });

  it.each(SCREENING_REASONS)('never a screening / sanctions hold (%j), alone or mixed', (r) => {
    expect(partnerMayRejectHold(held([r]), delegated, clean)).toBe(false);
    expect(partnerMayRejectHold(held([LARGE, r]), delegated, clean)).toBe(false);
  });

  it('never an AML hold, an unknown or empty reasons list', () => {
    expect(partnerMayRejectHold(held([AML_HOLD_REASON]), delegated, clean)).toBe(false);
    expect(partnerMayRejectHold(held(['Something new.']), delegated, clean)).toBe(false);
    expect(partnerMayRejectHold(held([]), delegated, clean)).toBe(false);
  });

  it("never for kycMode 'ours' or a missing owner", () => {
    expect(partnerMayRejectHold(held([LARGE]), ours, clean)).toBe(false);
    expect(partnerMayRejectHold(held([LARGE]), null, clean)).toBe(false);
  });

  it('never with a flagged, missing or failed sender lookup', () => {
    expect(partnerMayRejectHold(held([LARGE]), delegated, { pepHit: true })).toBe(false);
    expect(partnerMayRejectHold(held([LARGE]), delegated, { watchlistHit: true })).toBe(false);
    expect(partnerMayRejectHold(held([LARGE]), delegated, null)).toBe(false);
  });

  it('never a blocked row or one that is not in_review', () => {
    expect(partnerMayRejectHold(held([LARGE], { complianceStatus: 'blocked' }), delegated, clean)).toBe(false);
    for (const status of ['paid', 'cancelled', 'awaiting_payment', 'blocked', 'delivered']) {
      expect(partnerMayRejectHold(held([LARGE], { status }), delegated, clean)).toBe(false);
    }
  });
});

describe('kycQueueCounts', () => {
  const c = (partnerId: string, kycReviewState: KycReviewState | undefined, kycStatus: KycStatus = 'pending') =>
    ({ partnerId, kycReviewState, kycStatus }) as Pick<Customer, 'partnerId' | 'kycReviewState' | 'kycStatus'>;

  it('counts the tenant’s customers awaiting a decision (not those still in the hosted flow or decided)', () => {
    const rows = [
      c('pa', 'pending_review'),
      c('pa', 'needs_review'),
      c('pa', 'inquiry_started'),
      c('pa', 'approved', 'verified'),
      c('pa', undefined, 'not_started'),
    ];
    expect(kycQueueCounts(rows, 'pa')).toEqual({ awaiting: 2 });
  });

  it('ignores another tenant’s rows (defence in depth)', () => {
    expect(kycQueueCounts([c('pb', 'pending_review'), c('pb', 'needs_review')], 'pa')).toEqual({ awaiting: 0 });
  });

  it('never splits the queue by why it is there (no tipping off)', () => {
    expect(Object.keys(kycQueueCounts([], 'pa'))).toEqual(['awaiting']);
  });
});

describe('amlRuleKey (closed map, D5)', () => {
  it('maps every AML rule to its own label key', () => {
    expect(amlRuleKey('structuring')).toBe('partner.reviews.aml.rule.structuring');
    expect(amlRuleKey('first_transfer')).toBe('partner.reviews.aml.rule.first_transfer');
    expect(amlRuleKey('new_beneficiary')).toBe('partner.reviews.aml.rule.new_beneficiary');
    expect(amlRuleKey('cluster')).toBe('partner.reviews.aml.rule.cluster');
  });

  it('anything else (unknown, prototype keys, non-strings) is the generic label', () => {
    for (const v of ['nope', 'constructor', '__proto__', 'toString', '', undefined, null, 7, {}]) {
      expect(amlRuleKey(v)).toBe('partner.reviews.aml.rule.other');
    }
  });

  it('every key has English copy', () => {
    for (const k of [...Object.values(AML_RULE_KEYS), amlRuleKey('x')]) expect(t(k)).not.toBe(k);
  });
});

describe('AML alert form parsing (shared with the legacy compliance action)', () => {
  it('parseAmlAlertId accepts only a positive safe integer string', () => {
    expect(parseAmlAlertId('1')).toBe(1);
    expect(parseAmlAlertId(' 42 ')).toBe(42);
    expect(parseAmlAlertId('900719925474099')).toBe(900719925474099);
    for (const v of ['0', '-1', '01', '1.5', '1e3', 'abc', '', '9999999999999999', null, 7 as unknown as string]) {
      expect(parseAmlAlertId(v as never)).toBeNull();
    }
  });

  it('isAmlDisposition is the closed list no_action | escalated', () => {
    expect(AML_DISPOSITIONS).toEqual(['no_action', 'escalated']);
    expect(isAmlDisposition('no_action')).toBe(true);
    expect(isAmlDisposition('escalated')).toBe(true);
    for (const v of ['', 'cleared', 'NO_ACTION', 'constructor', null, undefined, 1]) expect(isAmlDisposition(v)).toBe(false);
  });
});
