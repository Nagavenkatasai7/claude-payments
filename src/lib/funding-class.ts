import { isPartnerPulled } from './funding-method';
import { selectFundingProvider } from './providers/funding-provider';
import type { FundingModeRecord } from './live-controls';
import type { PartnerFundingConfig } from './partner-integrations';
import type { Transfer } from './types';
import type { DbOrTx } from '@/db/client';
import { createRailMessageRepo } from '@/db/repos/rail-message-repo';
import { railGoLiveAt, railPartnerOf, realMoneyFor } from './live-gate';
import { logWarn } from './log';

// funding-class (fix pack 5 T12, P12): THE answer to "how was this sender's
// money collected", pure, from the ledger row only.
// (Review round 1: settleReachedLiveRail, collectedOnRealMoneyFor and
// collectedOnRealMoneyView at the end read the store; everything else is pure.)
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
 * Review round 1 RF1: a ROUTED row: settlementPartnerId set and not the owner.
 * The owner collected the sender's money but another partner's rail settles
 * it. Pure.
 */
export function isRoutedRow(t: Pick<Transfer, 'partnerId' | 'settlementPartnerId'>): boolean {
  return !!t.settlementPartnerId && t.settlementPartnerId !== t.partnerId;
}

/**
 * Fix pack 5 T15 (P15, M3): may this row be refunded although it carries no
 * fundingRef? Only a real-money PARTNER-COLLECTED row: the partner holds the
 * sender's money, so its refund is the signed reverse of P15 step 5. Pure; the
 * caller decides `realMoney` (realMoneyFor) and reads it only when the row has
 * no fundingRef.
 * Review round 1 RF1: never on a ROUTED row (isRoutedRow). The owner collected
 * the money, but the reverse would go to the settlement partner's rail. Who
 * returns it there is an owner question; until it is answered the class is
 * refused there (and the worker sends no reverse for it).
 * Review round 1 RC2: true here is necessary, not sufficient: the stored
 * admission is collectedOnRealMoneyFor (the settle instruction went to this
 * rail after its go-live).
 */
export function refundWithoutCharge(
  t: Pick<Transfer, 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef' | 'partnerId' | 'settlementPartnerId'>,
  realMoney: boolean,
): boolean {
  if (isRoutedRow(t)) return false;
  return realMoney && fundingClassOf(t) === 'partner_collected';
}

/**
 * Review round 1 RC2: did this row's settle instruction go to its rail partner
 * (railPartnerOf) at or after that partner went live? (a) the newest outbound
 * 'settle' record in rail_messages for this transfer and this rail partner
 * (ids only: no body is read or decrypted), and (b) its created_at is not older
 * than railGoLiveAt. A row settled in the demo era (a simulator rail, or before
 * pack 5 recorded anything) answers false. A failed read THROWS (never false,
 * never true).
 */
export async function settleReachedLiveRail(db: DbOrTx, t: Pick<Transfer, 'id' | 'partnerId' | 'settlementPartnerId'>): Promise<boolean> {
  const rail = railPartnerOf(t);
  const settledAt = await createRailMessageRepo(db).lastSettleOutAt(t.partnerId, t.id, rail);
  if (settledAt === null) return false;
  const liveAt = await railGoLiveAt(db, rail);
  return liveAt !== null && settledAt.getTime() >= liveAt.getTime();
}

type RefundAdmissionRow = Pick<
  Transfer,
  'id' | 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef' | 'partnerId' | 'settlementPartnerId'
>;

/**
 * Review round 1 RC2/RC3/RF1: THE admission of a refund with no charge, for
 * issueRefund (and the flag approveRefund / retryRefund carry in the
 * funding.refund payload): no fundingRef, refundWithoutCharge on the rail's
 * current real-money read (not routed, class partner_collected), and
 * settleReachedLiveRail. The rail type is read only when fundingRef is null;
 * the settle record and the go-live only for such a real-money row. A failed
 * settle or go-live read THROWS.
 */
export async function collectedOnRealMoneyFor(db: DbOrTx, t: RefundAdmissionRow): Promise<boolean> {
  if (t.fundingRef) return false;
  if (!refundWithoutCharge(t, await realMoneyFor(db, t))) return false;
  return settleReachedLiveRail(db, t);
}

/**
 * The page mirrors' view of collectedOnRealMoneyFor (show or hide Issue
 * refund): a failed read hides the button (logged by the error name, ids
 * only); issueRefund re-checks inside its transaction.
 */
export async function collectedOnRealMoneyView(db: DbOrTx, t: RefundAdmissionRow): Promise<boolean> {
  try {
    return await collectedOnRealMoneyFor(db, t);
  } catch (err) {
    logWarn('funding-class.refund-admission', err instanceof Error ? err.name : 'error', { transferId: t.id });
    return false;
  }
}
