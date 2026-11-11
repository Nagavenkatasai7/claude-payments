import { isPartnerPulled } from './funding-method';
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
