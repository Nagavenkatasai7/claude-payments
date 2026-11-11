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
// funding_mode  G14  slot (T14): mockfund done / InstructFundingModeError deferred
// build         G15  builder + compliance block, fail closed (P10)
// travel_rule   G16  slot (T23): InstructTravelRuleError deferred
// record        G17  slot (T9): the rail_messages record before the POST
// send          G18  the signed POST through withInstructDeliveryLog: RailInstructError
// provider_ref  G19  setProviderRef, write-once
//
// A row that fails two steps gets the earlier step's outcome.
//
// Alerts and logs carry ids and the reason only (never a phone, name, amount,
// destination or secret).

import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { realMoneyFor } from './live-gate';
import { logWarn } from './log';
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

/**
 * P9: the reason a stuck paid row is held ON PURPOSE by a later instruct gate,
 * or null. Not real money -> null with no further read (a 'test' row makes no
 * read at all). Never throws: a read error -> null (logged by the error name),
 * so the sweep behaves as today.
 */
export async function instructHeldOnPurpose(db: DbOrTx, t: Transfer): Promise<InstructHeldReason | null> {
  try {
    if (!(await realMoneyFor(db, t))) return null;
    // slot: funding_mode (G14; T14, P12/P17)
    // slot: travel_rule (G16; T23, P22)
    return null;
  } catch (err) {
    logWarn('instruct-gates.held', err instanceof Error ? err.name : 'error', { transferId: t.id });
    return null;
  }
}

export function heldStuckDedupeKey(reason: InstructHeldReason, transferId: string): string {
  return `${reason}:stuck:${transferId}`;
}

/** P9 text, one literal per reason (so the spec can quote it as written). */
export function stuckHeldMessage(transferId: string, reason: InstructHeldReason): string {
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
  t: Pick<Transfer, 'id' | 'complianceStatus'>,
  reason: InstructHeldReason,
): Promise<boolean> {
  if (t.complianceStatus === 'blocked') return false;
  const outbox = createOutboxRepo(db);
  if (await outbox.hasLiveInstruction(t.id)) return false;
  return outbox.enqueue(
    'ops.alert',
    { message: stuckHeldMessage(t.id, reason) },
    { dedupeKey: heldStuckDedupeKey(reason, t.id) },
  );
}
