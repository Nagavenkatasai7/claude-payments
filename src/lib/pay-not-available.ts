import { NextResponse } from 'next/server';
import { fixedReply } from './hold-replies';
import {
  PAY_ACCOUNT_HOLDER_COPY,
  PAY_APPROVAL_NOT_RECORDED_COPY,
  PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY,
  PAY_RELOAD_REQUIRED_COPY,
  PAY_RELOAD_REQUIRED_FUNDED_COPY,
  PAY_SENDER_ADDRESS_INVALID_COPY,
  PAY_SENDER_DOB_INVALID_COPY,
} from './pay-outcome';
import type { Transfer } from './types';

/**
 * Pack 3 (contract 5): the one neutral answer a pay route gives when a live
 * control (live certification, the default tenant on a live rail, a closed
 * capability) refused the mint or the pay. Nothing was minted, captured or
 * consumed. The body never names the reason: the customer sees the fixed
 * cannot_complete line, and the reason code is the neutral 'not_available'.
 *
 * A module of its own (imports only NextResponse, fixedReply and the fixed pay
 * copy of pay-outcome.ts, which is import-light and client-safe) so route tests
 * that vi.mock pay-process or a finalizer keep working.
 */
export const PAY_NOT_AVAILABLE = Object.freeze({
  status: 409,
  body: Object.freeze({
    ok: false,
    error: fixedReply('cannot_complete'),
    reason: 'not_available' as const,
  }),
});

/** A fresh 409 PAY_NOT_AVAILABLE response (a Response body is read once). */
export function payNotAvailable(): NextResponse {
  return NextResponse.json({ ...PAY_NOT_AVAILABLE.body }, { status: PAY_NOT_AVAILABLE.status });
}

/**
 * Review R1-P1 A1: an awaiting row that is already funded. A recorded capture
 * (fundingRef: a crash before settleOrHold, resumed by the sweep), a bank debit
 * bound to the row (fundingIntentRef) or a funding state of pending or
 * succeeded. Its answers never claim that nothing was charged. A draft (no
 * row yet) is never funded. Pure.
 */
export function transferFunded(t: Pick<Transfer, 'fundingRef' | 'fundingIntentRef' | 'fundingState'>): boolean {
  return !!t.fundingRef || !!t.fundingIntentRef || t.fundingState === 'pending' || t.fundingState === 'succeeded';
}

/**
 * Fix pack 4 (C10): an R18 refusal the customer fixes by reloading: the page
 * acknowledged no (or an older) disclosure, or a block other than the one on
 * file. The code was not consumed by this answer. Nothing was charged unless
 * the row is `funded` (review R1-P1 A1): then the body carries `funded: true`
 * and the text makes no claim about a charge.
 */
export function payReloadRequired(funded = false): NextResponse {
  return NextResponse.json(
    funded
      ? { ok: false, reason: 'reload_required', funded: true, error: PAY_RELOAD_REQUIRED_FUNDED_COPY }
      : { ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY },
    { status: 409 },
  );
}

/**
 * Fix pack 4 (C8): the evidence commit ("authorise, then capture") could not be
 * written, so this attempt charged nothing. The code is spent: the customer
 * taps Resend. On a `funded` row (review R1-P1 A1) the body carries
 * `funded: true` and the text makes no claim about a charge.
 */
export function payApprovalNotRecorded(funded = false): NextResponse {
  return NextResponse.json(
    funded
      ? { ok: false, reason: 'approval_not_recorded', funded: true, error: PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY }
      : { ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY },
    { status: 503 },
  );
}

/**
 * Fix pack 4 (C14, C18): the account-holder name the page posted is missing on
 * real money, not a string, or not a clean name of at most 80 characters.
 * Answered before the code is checked: nothing was consumed or charged.
 */
export function payAccountHolderInvalid(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'Please check the account holder name.', fieldErrors: { accountHolder: PAY_ACCOUNT_HOLDER_COPY } },
    { status: 400 },
  );
}

/**
 * Fix pack 5 (P21, R38): the sender's address or date of birth posted on a
 * real-money payment is not a string, or fails the travel-rule check (P18).
 * Answered before the code is checked: nothing was consumed or charged.
 */
export function payOriginatorInvalid(field: 'senderAddress' | 'senderDob'): NextResponse {
  const copy = field === 'senderAddress' ? PAY_SENDER_ADDRESS_INVALID_COPY : PAY_SENDER_DOB_INVALID_COPY;
  return NextResponse.json({ ok: false, error: 'originator_invalid', fieldErrors: { [field]: copy } }, { status: 400 });
}
