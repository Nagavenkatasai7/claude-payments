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
 * D3, the OFFER: which decision may the page show a partner admin? Only when the owning partner's
 * KYC mode is exactly 'delegated'. A customer in the queue is decided through the Persona-review
 * slug; any other customer through the manual override slug, where a no-op (approve a verified or
 * grandfathered customer, reject a rejected one) is refused so no audit row is written for nothing.
 * It NEVER reads the screening flags, so a flagged and an unflagged customer are offered the same
 * controls. Fails closed on a missing owner or customer and on an unknown decision.
 */
export function partnerKycOffer(
  owner: { kycMode?: string | null } | null | undefined,
  customer: Pick<Customer, 'kycStatus' | 'kycReviewState'> | null | undefined,
  decision: KycDecision,
): PartnerKycDecision {
  const no = { ok: false } as const;
  if (decision !== 'approve' && decision !== 'reject') return no;
  if (!owner || owner.kycMode !== 'delegated') return no;
  if (!customer) return no;
  if (isKycQueueState(customer.kycReviewState)) return { ok: true, slug: `kyc.review.${decision}`, source: 'persona_review' };
  if (decision === 'approve' && (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered')) return no;
  if (decision === 'reject' && customer.kycStatus === 'rejected') return no;
  return { ok: true, slug: `kyc.manual_override.${decision}`, source: 'manual' };
}

/** The decisions the customer page offers: partnerKycOffer for each (no screening input). */
export function partnerKycOfferedDecisions(
  owner: { kycMode?: string | null } | null | undefined,
  customer: Pick<Customer, 'kycStatus' | 'kycReviewState'> | null | undefined,
): KycDecision[] {
  return (['approve', 'reject'] as const).filter((d) => partnerKycOffer(owner, customer, d).ok);
}

/**
 * D3, the DECISION: may a partner admin record it? The offer above AND no PEP / watchlist hit on
 * the customer (isScreeningCustomerHold; the writer re-checks this on the LOCKED row with
 * allowScreeningHold:false).
 */
export function partnerKycDecision(
  owner: { kycMode?: string | null } | null | undefined,
  customer: Pick<Customer, 'kycStatus' | 'kycReviewState' | 'pepHit' | 'watchlistHit'> | null | undefined,
  decision: KycDecision,
): PartnerKycDecision {
  if (!customer || isScreeningCustomerHold(customer)) return { ok: false };
  return partnerKycOffer(owner, customer, decision);
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
  /** Awaiting a human decision: ONE count, never split by why a customer is in the queue. */
  awaiting: number;
}

/** The KYC status tile, over THIS tenant's rows only (another tenant's row is ignored). */
export function kycQueueCounts(
  customers: ReadonlyArray<Pick<Customer, 'partnerId' | 'kycReviewState'>>,
  partnerId: PartnerId,
): KycQueueCounts {
  let awaiting = 0;
  for (const c of customers) {
    if (c.partnerId === partnerId && isKycQueueState(c.kycReviewState)) awaiting += 1;
  }
  return { awaiting };
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

/** Program-Fix 43: the closed list of AML alert outcomes (shared with the legacy compliance action). */
export const AML_DISPOSITIONS = Object.freeze(['no_action', 'escalated'] as const);
export type AmlDisposition = (typeof AML_DISPOSITIONS)[number];

export function isAmlDisposition(v: unknown): v is AmlDisposition {
  return typeof v === 'string' && (AML_DISPOSITIONS as readonly string[]).includes(v);
}

/** An alert id from a form: a positive safe integer of at most 15 digits, else null. */
export function parseAmlAlertId(raw: FormDataEntryValue | null): number | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[1-9]\d{0,14}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
