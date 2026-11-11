import { isPartnerPulled } from './funding-method';
import { selectFundingProvider } from './providers/funding-provider';
import type { FundingModeRecord } from './live-controls';
import type { PartnerFundingConfig } from './partner-integrations';
import type { Transfer } from './types';

// funding-class (fix pack 5 T12, P12): THE answer to "how was this sender's
// money collected", pure, from the ledger row only.
//
// Order (first match wins):
//   1. environment 'test'                          -> 'sandbox'
//   2. isPartnerPulled(fundingMethod)              -> 'partner_pull'
//   3. fundingProvider 'stripe' OR fundingIntentRef -> 'stripe'
//      (the same "bound" rule as selectFundingProvider in
//      providers/funding-provider.ts and the pay-process funding decision: a
//      possible real debit is never read as mock)
//   4. fundingProvider 'mock'                      -> 'mock'
//   5. fundingRef set (provider NULL)              -> 'mock'
//      Every such row was charged by MockFundingProvider: captureFunding of an
//      older build (or of a build put back by Instant Rollback) wrote the ref
//      without stamping funding_provider.
//   6. otherwise                                   -> 'partner_collected'
//      (no provider, no ref, no intent: a Partner API confirm)
// Never the 'mockfund-' prefix of a reference: the class comes from the
// funding_provider column (written by setFundingRef / bindFundingIntent).

export type FundingClass = 'sandbox' | 'partner_pull' | 'stripe' | 'mock' | 'partner_collected';

export function fundingClassOf(
  t: Pick<Transfer, 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef'>,
): FundingClass {
  if (t.environment === 'test') return 'sandbox';
  if (isPartnerPulled(t.fundingMethod)) return 'partner_pull';
  if (t.fundingProvider === 'stripe' || !!t.fundingIntentRef) return 'stripe';
  if (t.fundingProvider === 'mock') return 'mock';
  if (t.fundingRef) return 'mock';
  return 'partner_collected';
}

/**
 * Fix pack 5 T14 (P17 match rule, G14b): does this funding class match the
 * OWNER's recorded funding mode? partner_pull always matches (the partner's
 * rail pulls on the instruction); stripe needs 'partner_psp';
 * partner_collected needs 'partner_collected'; no record mismatches every
 * other class. sandbox and mock never reach it (G2 / G14a decide them first).
 */
export function fundingModeMatches(cls: FundingClass, rec: FundingModeRecord | undefined): boolean {
  if (cls === 'partner_pull') return true;
  if (cls === 'stripe') return rec?.mode === 'partner_psp';
  if (cls === 'partner_collected') return rec?.mode === 'partner_collected';
  return false;
}

/**
 * Fix pack 5 T13a (P12, P13 step 7): a mock charge never backs a real payout.
 * True = refuse this payment (PAY_NOT_AVAILABLE) before any write or capture:
 * the rail moves real money, the row is not a B2B partner pull, it is not
 * already bound to a Stripe intent (fundTransfer decides those), and the
 * funding selection would not be Stripe (the mock, or a refused selection).
 * Pure: the caller reads the flag and the funding config (only on real money
 * with the flag on; a read that throws is passed as `config: null`). A draft
 * passes its own fields with fundingProvider / fundingIntentRef undefined.
 */
export function payFundingRefusal(
  t: Pick<Transfer, 'transferType' | 'fundingMethod' | 'fundingProvider' | 'fundingIntentRef' | 'partnerId' | 'settlementPartnerId' | 'environment'>,
  o: { realMoney: boolean; stripeEnabled: boolean; config: PartnerFundingConfig | null },
): boolean {
  if (!o.realMoney) return false;
  if (t.transferType === 'b2b' && isPartnerPulled(t.fundingMethod)) return false;
  if (t.fundingProvider === 'stripe' || !!t.fundingIntentRef) return false;
  return selectFundingProvider(t, { enabled: o.stripeEnabled, config: o.config }).kind !== 'stripe';
}

/**
 * Fix pack 5 T15 (P15, M3): may this row be refunded although it carries no
 * fundingRef? Only a real-money PARTNER-COLLECTED row: the partner holds the
 * sender's money, so its refund is the signed reverse of P15 step 5. Pure; the
 * caller decides `realMoney` (realMoneyFor) and reads it only when the row has
 * no fundingRef.
 */
export function refundWithoutCharge(
  t: Pick<Transfer, 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef'>,
  realMoney: boolean,
): boolean {
  return realMoney && fundingClassOf(t) === 'partner_collected';
}
