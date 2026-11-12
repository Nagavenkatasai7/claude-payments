import { isPartnerPulled } from './funding-method';
import { selectFundingProvider } from './providers/funding-provider';
import type { FundingModeRecord } from './live-controls';
import type { PartnerFundingConfig } from './partner-integrations';
import type { Transfer } from './types';
import type { DbOrTx } from '@/db/client';
import { createRailMessageRepo } from '@/db/repos/rail-message-repo';
import { railGoLiveAt, railPartnerOf, readRailProviderType, realMoneyFor, realMoneyRail } from './live-gate';
import { logWarn } from './log';
import { hasInstructDelivery } from './webhook-delivery-log';

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

/**
 * Final check F8 (X1, U1): was this row paid on its live rail and HELD before
 * its first instruction? On a real-money rail the settle record is written at
 * the instruct's `record` step, after `funding_mode` and `travel_rule`, so a
 * row those gates hold has NO outbound 'settle' record, yet a partner-collected
 * row's money is with the partner. True when no outbound 'settle' record
 * exists for this transfer and its rail partner (railPartnerOf), EXCEPT a
 * demo-era row: paidAt known AND the rail's go-live (railGoLiveAt) known AND
 * paidAt older than it. A missing (or unparseable) paidAt or a missing go-live
 * counts as held (the careful side: a person looks; the ledger never says
 * "refunded" for money a partner may hold). A row WITH a settle record is
 * never held (one older than the go-live stays demo era, RC2). Ids only; a
 * failed read THROWS (never true, never false).
 */
export async function heldBeforeFirstSettle(
  db: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'settlementPartnerId' | 'paidAt'>,
): Promise<boolean> {
  const rail = railPartnerOf(t);
  const settledAt = await createRailMessageRepo(db).lastSettleOutAt(t.partnerId, t.id, rail);
  if (settledAt !== null) return false;
  const paidAt = Date.parse(t.paidAt ?? '');
  if (Number.isNaN(paidAt)) return true;
  const liveAt = await railGoLiveAt(db, rail);
  if (liveAt === null) return true;
  return paidAt >= liveAt.getTime();
}

/**
 * Truth check F10 (F2): for a row heldBeforeFirstSettle calls held (no outbound settle record),
 * is there evidence that an instruction was POSTed WITHOUT a record (a build older than fix pack
 * 5, e.g. after an Instant Rollback past PR5, or a rail certified before this pack deployed)? The
 * row's payment_provider_ref is set (an older build's write-once ack), or a settlement.instruct
 * delivery row exists for this transfer and its rail partner (railPartnerOf; any outcome). Read
 * only inside that held branch: a demo-era row has both from the simulator and closes as before.
 * Ids only; a failed read THROWS.
 */
export async function instructSentWithoutRecord(
  db: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'settlementPartnerId' | 'paymentProviderRef'>,
): Promise<boolean> {
  if (t.paymentProviderRef) return true;
  return hasInstructDelivery(db, railPartnerOf(t), t.id);
}

type RefundAdmissionRow = Pick<
  Transfer,
  'id' | 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef' | 'partnerId' | 'settlementPartnerId' | 'paidAt'
>;

/**
 * Review round 1 RC2/RC3/RF1: THE admission of a refund with no charge, for
 * issueRefund (and the flag approveRefund / retryRefund carry in the
 * funding.refund payload): no fundingRef, refundWithoutCharge on the rail's
 * current real-money read (not routed, class partner_collected), and either
 * settleReachedLiveRail or (final check F8, X1 U1) heldBeforeFirstSettle: a
 * row a gate held before its first instruction (the partner holds the money;
 * the worker then sends no reverse, leaves the refund pending and raises
 * refundheld:<id>). A demo-era row is still refused. The rail type is read
 * only when fundingRef is null; the settle record and the go-live only for
 * such a real-money row. A failed settle or go-live read THROWS.
 */
export async function collectedOnRealMoneyFor(db: DbOrTx, t: RefundAdmissionRow): Promise<boolean> {
  if (t.fundingRef) return false;
  if (!refundWithoutCharge(t, await realMoneyFor(db, t))) return false;
  if (await settleReachedLiveRail(db, t)) return true;
  return heldBeforeFirstSettle(db, t);
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

/**
 * Review round 2 GE1: why staff cannot refund a real-money card payment from
 * SmartRemit (the Stripe provider's refund is not built, so a funding.refund
 * would stay 'pending' for good). Staff-facing; no id, amount or name.
 */
export const CARD_REFUND_UNAVAILABLE =
  "this transfer was paid by card through the partner's Stripe account. Card refunds are made in the partner's Stripe dashboard; SmartRemit cannot refund a card payment yet.";

/**
 * Review round 2 GE1: is this a card payment (funding class 'stripe') on a
 * real-money rail? Such a row cannot be refunded from SmartRemit yet, so
 * issueRefund, approveRefund and retryRefund refuse it. Any other class
 * (sandbox rows are class 'sandbox') answers false with NO read. A failed
 * rail-type read THROWS (never read as real money or as demo here).
 */
export async function cardRefundUnavailableFor(
  db: DbOrTx,
  t: Pick<Transfer, 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef' | 'partnerId' | 'settlementPartnerId'>,
): Promise<boolean> {
  if (fundingClassOf(t) !== 'stripe') return false;
  const railProviderType = await readRailProviderType(db, railPartnerOf(t));
  if (railProviderType === undefined) throw new Error('rail_read_failed');
  return realMoneyRail({ environment: t.environment, railProviderType });
}

/**
 * The page mirrors' view of cardRefundUnavailableFor (hide Issue refund): a
 * failed read hides the button (logged by the error name, ids only); the core
 * re-checks inside its transaction.
 */
export async function cardRefundUnavailableView(db: DbOrTx, t: RefundAdmissionRow): Promise<boolean> {
  try {
    return await cardRefundUnavailableFor(db, t);
  } catch (err) {
    logWarn('funding-class.card-refund', err instanceof Error ? err.name : 'error', { transferId: t.id });
    return true;
  }
}
