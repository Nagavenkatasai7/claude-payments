import { decideStaffCancel } from './dashboard-cancel-policy';
import { isPartnerPulled } from './funding-method';
import type { Transfer } from './types';

// Fix pack 7 F2 (early review EE1, P14 "Refund back doors"): the actions column
// of the B2B transfers table on /admin-dashboard/b2b, as one pure decision so a
// test pins it. Before F2 the page inlined the same branches; the one new case
// is 'reverse_refused': a row whose Reverse reverseB2bSettlement would refuse
// (refundHoldRefusals with { reverse: true }) shows its fixed line instead of
// the form. PURE and client-safe (the imports are pure).

type B2bRowView = Pick<Transfer, 'id' | 'status' | 'fundingMethod' | 'fundingRef'> & Partial<Pick<Transfer, 'fundingIntentRef'>>;

export type B2bRowControl =
  | { kind: 'cancel' }
  | { kind: 'reverse' }
  | { kind: 'reverse_refused'; text: string }
  | { kind: 'in_review' }
  | { kind: 'charged' }
  | { kind: 'recall' }
  | { kind: 'none' };

/** The rows that show the Reverse form (the only rows the page reads refusals for). */
export function showsReverse(t: B2bRowView): boolean {
  return decideStaffCancel(t).kind !== 'void' && t.status === 'paid' && isPartnerPulled(t.fundingMethod);
}

/** `reverseRefusals`: the refusal text per id (refundHoldRefusals(db, rows, { reverse: true })). */
export function b2bRowControl(t: B2bRowView, reverseRefusals: ReadonlyMap<string, string>): B2bRowControl {
  if (decideStaffCancel(t).kind === 'void') return { kind: 'cancel' };
  if (showsReverse(t)) {
    const text = reverseRefusals.get(t.id);
    return text ? { kind: 'reverse_refused', text } : { kind: 'reverse' };
  }
  if (t.status === 'in_review') return { kind: 'in_review' };
  if (t.status === 'awaiting_payment') return { kind: 'charged' };
  if (t.status === 'delivered') return { kind: 'recall' };
  return { kind: 'none' };
}
