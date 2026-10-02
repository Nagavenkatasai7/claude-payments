import { isPartnerReleasableHold, isScreeningCustomerHold } from '@/lib/compliance-config';
import type { MessageKey } from '@/lib/i18n';
import type { AmlRule } from '@/lib/aml-rules';
import type { Customer, PartnerId } from '@/lib/types';

// partner-reviews (merge plan 2c): the PURE rules behind /partner/reviews and its three decisions.
// Owner decisions D3 (KYC), D4 (reject a hold) and D5 (AML alerts, admin only). Every refusal is a
// bare { ok: false } with no reason, so a caller can never surface WHY (a screening hit and an
// 'ours'-mode partner read the same: nothing is tipped off).

export type KycDecision = 'approve' | 'reject';
export type PartnerKycDecision =
  | { ok: true; slug: `kyc.review.${KycDecision}` | `kyc.manual_override.${KycDecision}`; source: 'persona_review' | 'manual' }
  | { ok: false };

/** The review states that mean "a human must decide" (the KYC queue). */
export function isKycQueueState(s: unknown): boolean {
  return s === 'pending_review' || s === 'needs_review';
}

/**
 * D3: may a partner admin record this KYC decision? Only when the owning partner's KYC mode is
 * exactly 'delegated' AND the customer carries no PEP / watchlist hit (isScreeningCustomerHold;
 * the caller re-checks this on the LOCKED row with allowScreeningHold:false). A customer in the
 * queue is decided through the Persona-review slug; any other customer through the manual
 * override slug, where a no-op (approve a verified or grandfathered customer, reject a rejected
 * one) is refused so no audit row is written for nothing. Fails closed on a missing owner or
 * customer and on an unknown decision.
 */
export function partnerKycDecision(
  owner: { kycMode?: string | null } | null | undefined,
  customer: Pick<Customer, 'kycStatus' | 'kycReviewState' | 'pepHit' | 'watchlistHit'> | null | undefined,
  decision: KycDecision,
): PartnerKycDecision {
  const no = { ok: false } as const;
  if (decision !== 'approve' && decision !== 'reject') return no;
  if (!owner || owner.kycMode !== 'delegated') return no;
  if (!customer || isScreeningCustomerHold(customer)) return no;
  if (isKycQueueState(customer.kycReviewState)) return { ok: true, slug: `kyc.review.${decision}`, source: 'persona_review' };
  if (decision === 'approve' && (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered')) return no;
  if (decision === 'reject' && customer.kycStatus === 'rejected') return no;
  return { ok: true, slug: `kyc.manual_override.${decision}`, source: 'manual' };
}

/**
 * D4: a partner admin may reject (and so refund) ONLY a hold it may release: the same rule as
 * isPartnerReleasableHold (delegated KYC, in_review, not blocked, every reason KYC-class, the
 * sender's customer row present with no PEP / watchlist hit). Sanctions, screening and AML holds
 * stay PLATFORM-only for both outcomes.
 */
export function partnerMayRejectHold(
  t: { status: string; complianceStatus?: string | null; complianceReasons?: readonly string[] | null },
  owner: { kycMode?: string | null } | null | undefined,
  sender: { watchlistHit?: boolean | null; pepHit?: boolean | null } | null | undefined,
): boolean {
  return isPartnerReleasableHold(t, owner, sender);
}

export interface KycQueueCounts {
  /** Awaiting a human decision (one count: the queue is never split by why a customer is in it). */
  awaiting: number;
  /** Still in the hosted verification flow. */
  inProgress: number;
}

/** The KYC status tiles, over THIS tenant's rows only (another tenant's row is ignored). */
export function kycQueueCounts(
  customers: ReadonlyArray<Pick<Customer, 'partnerId' | 'kycReviewState'>>,
  partnerId: PartnerId,
): KycQueueCounts {
  let awaiting = 0;
  let inProgress = 0;
  for (const c of customers) {
    if (c.partnerId !== partnerId) continue;
    if (isKycQueueState(c.kycReviewState)) awaiting += 1;
    else if (c.kycReviewState === 'inquiry_started') inProgress += 1;
  }
  return { awaiting, inProgress };
}

/** D5: the ONLY thing a partner admin sees about an AML rule is one label. A closed map. */
export const AML_RULE_KEYS: Readonly<Record<AmlRule, MessageKey>> = Object.freeze({
  structuring: 'partner.reviews.aml.rule.structuring',
  first_transfer: 'partner.reviews.aml.rule.first_transfer',
  new_beneficiary: 'partner.reviews.aml.rule.new_beneficiary',
  cluster: 'partner.reviews.aml.rule.cluster',
});

export function amlRuleKey(rule: unknown): MessageKey {
  return typeof rule === 'string' && Object.hasOwn(AML_RULE_KEYS, rule)
    ? AML_RULE_KEYS[rule as AmlRule]
    : 'partner.reviews.aml.rule.other';
}
