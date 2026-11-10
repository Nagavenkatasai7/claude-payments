import type { FundingMethod, TransferStatus } from './types';

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

/** What happened to the sender's money, as far as SmartRemit can tell. */
export type SenderChargeState = 'charged' | 'partner_collected' | 'none';

/**
 * The statuses a row reaches only after a payment was confirmed: in_review
 * (settlement.beginHold, transfer-repo markInReviewIfAwaiting, with the held
 * "payment received, under review" stage-1 message), paid (markPaidIfAwaiting /
 * markPaidIfInReview) and delivered (after paid).
 */
const PAYMENT_CONFIRMED_STATUSES: ReadonlySet<TransferStatus> = new Set<TransferStatus>(['in_review', 'paid', 'delivered']);

/**
 * Pack 2 review round 4 (S4: N1, P1): THE answer to "what happened to the
 * sender's money" for the sanctions block notices and the match alerts.
 *   • 'charged': the funds-capture seam wrote a charge reference (`fundingRef`)
 *     and the method is not partner-pulled.
 *   • 'partner_collected': no charge reference, not partner-pulled, and a
 *     payment was confirmed: the row is in review, paid or delivered, or the
 *     caller is the partner's own confirm call (`partnerConfirmed`). A
 *     Partner-API row never gets a fundingRef: its confirm is the partner's
 *     attestation that it collected the sender's funds.
 *   • 'none': everything else, including a partner-pulled method (ach_pull /
 *     bank_pull: SmartRemit captures nothing; the partner's rail pulls only on
 *     the signed instruction, so a caller that knows the row was possibly
 *     instructed says the rail may have pulled the funds).
 */
export function senderChargeState(
  t: { fundingMethod: FundingMethod; fundingRef?: string | null; status: TransferStatus },
  opts: { partnerConfirmed?: boolean } = {},
): SenderChargeState {
  if (isPartnerPulled(t.fundingMethod)) return 'none';
  if (t.fundingRef) return 'charged';
  return opts.partnerConfirmed || PAYMENT_CONFIRMED_STATUSES.has(t.status) ? 'partner_collected' : 'none';
}
