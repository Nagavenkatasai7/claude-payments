import { NextResponse } from 'next/server';
import { fixedReply } from './hold-replies';

/**
 * Pack 3 (contract 5): the one neutral answer a pay route gives when a live
 * control (live certification, the default tenant on a live rail, a closed
 * capability) refused the mint or the pay. Nothing was minted, captured or
 * consumed. The body never names the reason: the customer sees the fixed
 * cannot_complete line, and the reason code is the neutral 'not_available'.
 *
 * A module of its own (imports only NextResponse and fixedReply) so route tests
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
