// Review S2 (Program-Fix 32): the pay routes answer a POST on a row that is no
// longer awaiting payment with 200 { ok: true, status } (ruling 7 keeps that
// contract fixed — api/pay/[transferId]/route.ts refuseUnlessAwaiting). A
// CANCELLED row (an expired unpaid link, a staff cancel) must read as a dead
// link on the client, never "Payment complete". Pure, so it is unit-tested;
// the forms are UI and are not.

export type PayOkStatus = 'done' | 'inactive';

/** The client state for a 2xx pay response body (unparsable ⇒ done, as before). */
export function payOkStatus(body: unknown): PayOkStatus {
  if (body && typeof body === 'object' && (body as { status?: unknown }).status === 'cancelled') {
    return 'inactive';
  }
  return 'done';
}
