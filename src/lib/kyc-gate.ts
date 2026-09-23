import type { KycStatus, Partner } from './types';
import { resolveKycMode } from './partner-config';
import type { PartnerIntegrations } from './partner-integrations';

/** The single machine-readable reason a send is gated for missing KYC. */
export const SEND_GATE_REASON = 'kyc_required' as const;

/**
 * WL1 white-label gate: whether SmartRemit's OWN verify-before-send gate is
 * active for this partner. true ⇒ enforce isSendVerified (the default / 'ours'
 * partner — unchanged). false ⇒ the partner is the licensed entity running KYC
 * on their side ('delegated'), so we short-circuit our gate.
 *
 * ⚠️ This governs ONLY identity verification. Sanctions/OFAC screening
 * (screenTransfer) is NEVER governed here and runs in BOTH modes — it has no
 * toggle anywhere. A delegated partner skips our KYC gate but every transfer is
 * still sanctions-screened.
 */
export function sendGateActive(partner: Partner | null | undefined): boolean {
  return resolveKycMode(partner).requireKyc;
}

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

/**
 * B2B KYB send gate (MVP). A business sender reuses the same customer verify
 * machine — its customer record must be 'verified' to send. Sanctions screening
 * still runs regardless (screenTransfer screens the business name). A richer
 * entity-registration KYB flow (Companies House etc.) is a follow-up.
 */
export function isB2bSendVerified<T extends { kycStatus: KycStatus }>(
  customer: T | null | undefined,
): customer is T & { kycStatus: 'verified' } {
  return isSendVerified(customer);
}

/** Whether the partner enforces our KYB gate before a B2B send (mirrors sendGateActive). */
export function requiresKyb(partner: Partner | null | undefined): boolean {
  return sendGateActive(partner);
}

/**
 * Program-Fix 35 (read-only partner-page warning): the verify-before-send gate
 * is OFF while the partner settles on a provider other than the mock rail
 * (absent or blank ⇒ mock). Display only — it never changes the gate.
 */
export function gateOffOnLiveRail(
  partner: Partner | null | undefined,
  integrations: Pick<PartnerIntegrations, 'payment'>,
): boolean {
  const provider = (integrations.payment.providerType ?? '').trim() || 'mock';
  return !sendGateActive(partner) && provider !== 'mock';
}
