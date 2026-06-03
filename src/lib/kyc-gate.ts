import type { KycStatus } from './types';

/** The single machine-readable reason a send is gated for missing KYC. */
export const SEND_GATE_REASON = 'kyc_required' as const;

/**
 * Phase-3 verify-before-send predicate. ONLY 'verified' may send — NOT
 * 'grandfathered' (pre-existing senders must now onboard), and NOT a customer
 * mid-review ('pending' while kycReviewState is pending_review/needs_review).
 *
 * Deliberately SEPARATE from tier-rules.deriveTier so the observation-window /
 * cap invariant stays byte-for-byte (deriveTier still treats grandfathered as
 * T1 for *amount* limits; this gate governs whether they may send AT ALL).
 */
export function isSendVerified<T extends { kycStatus: KycStatus }>(
  customer: T | null | undefined,
): customer is T & { kycStatus: 'verified' } {
  return customer?.kycStatus === 'verified';
}
