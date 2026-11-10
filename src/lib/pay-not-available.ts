import { NextResponse } from 'next/server';
import { fixedReply } from './hold-replies';
import { PAY_APPROVAL_NOT_RECORDED_COPY, PAY_RELOAD_REQUIRED_COPY } from './pay-outcome';

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
 * Fix pack 4 (C10): an R18 refusal the customer fixes by reloading: the page
 * acknowledged no (or an older) disclosure, or a block other than the one on
 * file. Nothing was charged and the code was not consumed by this answer.
 */
export function payReloadRequired(): NextResponse {
  return NextResponse.json({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY }, { status: 409 });
}

/**
 * Fix pack 4 (C8): the evidence commit ("authorise, then capture") could not be
 * written, so nothing was charged. The code is spent: the customer taps Resend.
 */
export function payApprovalNotRecorded(): NextResponse {
  return NextResponse.json(
    { ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY },
    { status: 503 },
  );
}
