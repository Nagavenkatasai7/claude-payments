import type { FundingMethod } from './types';

// funding-method — the single predicate for "is this a NON-CUSTODIAL,
// partner-pulled funding method?" Both 'ach_pull' (US-domestic B2B) and
// 'bank_pull' (cross-border B2B) are pulled by the LICENSED PARTNER's rail via
// the signed settlement instruction — SmartRemit NEVER captures funds for either.
//
// Every place that special-cases the non-custodial path (skip the funds capture,
// reverse instead of PSP-refund, "no direct cancel" guard, reversal wording)
// MUST gate on THIS, so a future funding method can't silently fall into a
// custodial branch.
export function isPartnerPulled(fundingMethod: FundingMethod): boolean {
  return fundingMethod === 'ach_pull' || fundingMethod === 'bank_pull';
}

/**
 * Pack 2 review round 3 (S2: M2, M6): THE answer to "was the sender charged"
 * for the sanctions block notices and the list re-screen alert. True only when
 * the funds-capture seam wrote a charge reference (`fundingRef`) and the method
 * is not partner-pulled: for ach_pull / bank_pull SmartRemit captures nothing
 * (the partner's rail pulls only on the signed instruction).
 */
export function senderWasCharged(t: { fundingMethod: FundingMethod; fundingRef?: string | null }): boolean {
  return Boolean(t.fundingRef) && !isPartnerPulled(t.fundingMethod);
}
