// instruct-gates — Fix pack 5 T6 (P8, P9): the settlement.instruct gate order
// and the stuck-paid sweeps' skip helper. Server only (DB reads). Must not
// import outbox-worker (no cycle): the worker's handler is laid out in this
// order, each step headed by one gate marker comment (`gate: <id>`), and tests/instruct-gate-order.test.ts
// pins the markers to the constant.
//
// id            P8   outcome class
// read          G1   decrypt failure: InstructPermanentError('decrypt'), terminal
// sandbox       G2   done + sandboxinstruct:<id>
// not_payable   G3   done (log)
// not_paid      G4   plain throw, charged retry
// funding_state G5   returned: done + instructreturned:<id>; pending/failed: charged retry
// railamount    G6   done (log)
// paused        G7   SettlementPausedError, deferred uncharged 300 s
// integrations  G8   rail read throws: charged retry
// pause_unknown G9   SettlementPausedError (switch unreadable on real money)
// live_cert     G10  InstructNotCertifiedError, deferred uncharged 900 s + livegate:<id>
// rail_config   G11  RailInstructError (no URL / URL refused / no signing secret), charged
// live_list     G12  InstructNotLiveError + instructnotlive:<id>, charged
// sender_hold   G13  InstructNotLiveError + instructsenderhold:<id>, charged
// funding_mode  G14  real money: a mock-funded row -> done + mockfund:<id>; a class that does not
//                    match the OWNER's fundingMode -> InstructFundingModeError deferred 900 s + fundmode:<id>
// build         G15  builder + compliance block, fail closed (P10)
// travel_rule   G16  real money: travel-rule data missing or routed (P22) -> InstructTravelRuleError
//                    deferred 900 s + travelrule:<id>; then the defence check (non-exempt individuals)
// record        G17  the rail_messages record before the POST: RailRecordError + railrecord:<hour>, charged
// send          G18  the signed POST through withInstructDeliveryLog: RailInstructError
// provider_ref  G19  setProviderRef, write-once
//
// A row that fails two steps gets the earlier step's outcome.
//
// Alerts and logs carry ids and the reason only (never a phone, name, amount,
// destination or secret).

import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { fundingClassOf, fundingModeMatches, type FundingClass } from './funding-class';
import type { FundingMode } from './live-controls';
import { railPartnerOf, readRailProviderType, realMoneyRail } from './live-gate';
import { logWarn } from './log';
import { originatorInfoMissing } from './originator-info';
import { travelRuleRequirement, type TravelRuleRequirement } from './travel-rule';
import type { Transfer } from './types';

export const INSTRUCT_GATE_ORDER = Object.freeze([
  'read',
  'sandbox',
  'not_payable',
  'not_paid',
  'funding_state',
  'railamount',
  'paused',
  'integrations',
  'pause_unknown',
  'live_cert',
  'rail_config',
  'live_list',
  'sender_hold',
  'funding_mode',
  'build',
  'travel_rule',
  'record',
  'send',
  'provider_ref',
] as const);

export type InstructGateId = (typeof INSTRUCT_GATE_ORDER)[number];

/** Why a later instruct gate holds a paid row on purpose (G14 a/b, G16). */
export type InstructHeldReason = 'mockfund' | 'fundmode' | 'travelrule';

/** Fix pack 5 T14 (P17, P8 G14): why the funding_mode gate holds a real-money row. */
export type FundingGateRefusal = { reason: 'mockfund' } | { reason: 'fundmode'; recorded: FundingMode | null };

/**
 * Fix pack 5 T14 (P8 G14, P17): the funding_mode gate's predicate. The caller
 * has decided the row is on real money. A mock-class row (the demo funding
 * provider collected nothing) -> 'mockfund'; a partner-pulled row passes with
 * no read; any other class must match the OWNER partner's recorded
 * live_controls.fundingMode (absent = mismatch) or -> 'fundmode' with the
 * recorded mode. A failed owner read THROWS (the worker retries, charged).
 */
export async function fundingGateRefusal(db: DbOrTx, t: Transfer): Promise<FundingGateRefusal | null> {
  const cls = fundingClassOf(t);
  if (cls === 'mock') return { reason: 'mockfund' };
  if (cls === 'partner_pull') return null;
  const rec = (await createPartnerRepo(db).getPartner(t.partnerId))?.liveControls?.fundingMode;
  return fundingModeMatches(cls, rec) ? null : { reason: 'fundmode', recorded: rec?.mode ?? null };
}

/**
 * Fix pack 5 T23 (P8 G16, P22): the travel_rule gate's predicate. Not real
 * money -> false with no read. Otherwise originatorInfoMissing (not exempt AND
 * routed or the band's data not on file). `known.exempt` is the exemption the
 * worker already read in its build step (one read per drain). A read error
 * THROWS (the worker retries, charged).
 */
export async function travelRuleBlocksInstruct(
  db: DbOrTx,
  t: Transfer,
  realMoney: boolean,
  known: { exempt?: boolean } = {},
): Promise<boolean> {
  if (!realMoney) return false;
  return originatorInfoMissing(db, t, known);
}

/**
 * Fix pack 5 T23 (P22, P10): the travel-rule requirement the compliance block
 * is built with: real money AND b2c (exempt rows included, so an address the
 * Partner API stored is sent), else null (no new key). Pure.
 */
export function travelRuleFor(t: Transfer, realMoney: boolean): TravelRuleRequirement | null {
  return realMoney && (t.transferType ?? 'b2c') === 'b2c'
    ? travelRuleRequirement({ destinationCountry: t.destinationCountry, amountUsd: t.amountUsd })
    : null;
}

/**
 * Fix pack 5 T23 (P22 defence check): true when a travel-rule requirement is
 * set and the BUILT originator lacks a field it asks for (null originator, no
 * `address`, or no `date_of_birth` in the DOB band). Pure; the caller decides
 * who it applies to (non-exempt individual senders).
 */
export function travelRuleBlockIncomplete(
  rule: TravelRuleRequirement | null,
  originator: object | null | undefined,
): boolean {
  if (!rule) return false;
  if (!originator) return true;
  return !('address' in originator) || (rule.dateOfBirth && !('date_of_birth' in originator));
}

/**
 * P9: the reason a stuck paid row is held ON PURPOSE by a later instruct gate,
 * or null. Not real money -> null with no further read (a 'test' row makes no
 * read at all). Never throws: a read error -> null (logged by the error name),
 * so the sweep behaves as today.
 *
 * Review round 1 (RA1): the rail type is read here directly, NOT through
 * realMoneyFor: readRailProviderType turns a failed read into undefined, which
 * realMoneyRail (rightly, for the gates that hold or refuse) reads as real
 * money. Here a failed read must mean "behave as today" (null), or a demo row
 * would get a false permanent mockfund:stuck alert and miss a sweep pass.
 */
export async function instructHeldOnPurpose(db: DbOrTx, t: Transfer): Promise<InstructHeldReason | null> {
  try {
    if (t.environment === 'test') return null;
    const railProviderType = await readRailProviderType(db, railPartnerOf(t));
    if (railProviderType === undefined) {
      logWarn('instruct-gates.held', 'rail_read_failed', { transferId: t.id });
      return null;
    }
    if (!realMoneyRail({ environment: t.environment, railProviderType })) return null;
    // funding_mode (G14; T14, P12/P17): the same predicate as the worker.
    const f = await fundingGateRefusal(db, t);
    if (f) return f.reason;
    // travel_rule (G16; T23, P22): the same predicate as the worker.
    if (await travelRuleBlocksInstruct(db, t, true)) return 'travelrule';
    return null;
  } catch (err) {
    logWarn('instruct-gates.held', err instanceof Error ? err.name : 'error', { transferId: t.id });
    return null;
  }
}

export function heldStuckDedupeKey(reason: InstructHeldReason, transferId: string): string {
  return `${reason}:stuck:${transferId}`;
}

/**
 * P9 text, one literal per reason (so the spec can quote it as written).
 * Review round 2 GE1: a row of funding class 'stripe' (a card payment through
 * the partner's Stripe key) is never sent to Issue refund, which cannot refund
 * a card payment yet (issueRefund refuses it): its fundmode and travelrule
 * texts name partner_psp and the partner's Stripe dashboard instead. Every
 * other class (or none given) keeps the text byte for byte.
 */
export function stuckHeldMessage(transferId: string, reason: InstructHeldReason, cls?: FundingClass): string {
  if (cls === 'stripe' && reason === 'fundmode') {
    return `transfer ${transferId} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (fundmode), so it is not re-instructed. If the partner's own payment provider collects card payments, record the funding mode partner_psp on the go-live card (then the stuck-paid sweep re-instructs it once); otherwise return the sender's money in the partner's Stripe dashboard (SmartRemit cannot refund a card payment yet, so the transfer then stays paid and held here).`;
  }
  if (cls === 'stripe' && reason === 'travelrule') {
    return `transfer ${transferId} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (travelrule), so it is not re-instructed. Return the sender's money in the partner's Stripe dashboard (SmartRemit cannot refund a card payment yet, so the transfer then stays paid and held here).`;
  }
  switch (reason) {
    case 'mockfund':
      return `transfer ${transferId} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (mockfund), so it is not re-instructed. Close it with Issue refund: it completes as nofunds-${transferId} without moving money.`;
    case 'fundmode':
      return `transfer ${transferId} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (fundmode), so it is not re-instructed. Record the right funding mode on the go-live card (then the stuck-paid sweep re-instructs it once) or Issue refund.`;
    case 'travelrule':
      return `transfer ${transferId} is paid with no delivery confirmation and no instruction waiting, and it is held on purpose (travelrule), so it is not re-instructed. Issue refund to return the sender's money.`;
  }
}

/**
 * P9 (mirror of alertStuckLivegate, livegate-alerts.ts; pack 3 review I1):
 * called by both stuck-paid sweeps for a row instructHeldOnPurpose holds. A
 * sanctions-blocked row -> false (its paidmatch alert owns it). While a
 * settlement.instruct row is live (pending, processing or failed) the worker's
 * own alert owns it -> false. Otherwise ONE deduped ops.alert
 * `<reason>:stuck:<id>`. A failed read throws, as every other sweep read does.
 * Returns true when a fresh alert was queued.
 */
export async function alertStuckHeld(
  db: DbOrTx,
  t: Pick<Transfer, 'id' | 'complianceStatus' | 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef'>,
  reason: InstructHeldReason,
): Promise<boolean> {
  if (t.complianceStatus === 'blocked') return false;
  const outbox = createOutboxRepo(db);
  if (await outbox.hasLiveInstruction(t.id)) return false;
  return outbox.enqueue(
    'ops.alert',
    { message: stuckHeldMessage(t.id, reason, fundingClassOf(t)) },
    { dedupeKey: heldStuckDedupeKey(reason, t.id) },
  );
}
