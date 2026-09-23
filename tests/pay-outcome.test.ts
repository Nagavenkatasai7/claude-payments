import { describe, it, expect } from 'vitest';
import { payErrorMessage, payOkStatus } from '@/lib/pay-outcome';

// Review S2 (Program-Fix 32): the pay route's contract is fixed (ruling 7) — a
// POST on a row that is no longer awaiting payment answers 200
// { ok: true, status }. The client must not read a CANCELLED answer (an expired
// link, a staff cancel) as "Payment complete".
describe('payOkStatus', () => {
  it("a 200 carrying status 'cancelled' is the inactive state, never done", () => {
    expect(payOkStatus({ ok: true, status: 'cancelled' })).toBe('inactive');
  });

  it('every other 200 is done (paid, processing, in_review, delivered, no status, unparsable body)', () => {
    for (const body of [{ ok: true, status: 'paid' }, { ok: true, status: 'processing' }, { ok: true, status: 'in_review' },
      { ok: true, status: 'delivered' }, { ok: true }, null, 'x']) {
      expect(payOkStatus(body), JSON.stringify(body)).toBe('done');
    }
  });
});

// Program-Fix 14 follow-up: the two refusals the customer can act on in chat
// get their own copy on the pay page; every other failure keeps the generic text.
describe('payErrorMessage', () => {
  it('sender_name_required asks for the full legal name in the WhatsApp chat', () => {
    const m = payErrorMessage({ ok: false, reason: 'sender_name_required', error: 'x' });
    expect(m).toMatch(/full legal name/i);
    expect(m).toMatch(/WhatsApp/);
  });

  it('kyc_required (the 403 flag or the reason) asks to complete verification in the WhatsApp chat', () => {
    for (const body of [{ ok: false, kyc_required: true }, { ok: false, reason: 'kyc_required' }]) {
      const m = payErrorMessage(body);
      expect(m, JSON.stringify(body)).toMatch(/verification/i);
      expect(m).toMatch(/WhatsApp/);
    }
  });

  it('never echoes server text and returns null for anything else', () => {
    for (const body of [{ ok: false, error: '<b>injected</b>' }, { reason: 'otp' }, { reason: 'busy' }, null, 'x', { kyc_required: 'yes' }]) {
      expect(payErrorMessage(body), JSON.stringify(body)).toBeNull();
    }
  });
});
