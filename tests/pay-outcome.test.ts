import { describe, it, expect } from 'vitest';
import {
  PAY_FX_UNAVAILABLE_COPY, PAY_QUOTE_EXPIRED_COPY, PAY_RATE_EXPIRED_COPY, PAY_RATE_EXPIRED_PAYMENT_PENDING_COPY,
  PAY_TEMPORARY_COPY, payErrorMessage, payOkStatus,
  PAY_RELOAD_REQUIRED_COPY, PAY_APPROVAL_NOT_RECORDED_COPY, PAY_ACCOUNT_HOLDER_COPY, disclosureAckBody, esignConsentBody,
  PAY_RELOAD_REQUIRED_FUNDED_COPY, PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY,
} from '@/lib/pay-outcome';
import { FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';

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

  it('temporarily_unavailable (the 503 on an infra error) asks to try again, never claims nothing was charged', () => {
    const m = payErrorMessage({ ok: false, reason: 'temporarily_unavailable', error: 'x' });
    expect(m).toBe(PAY_TEMPORARY_COPY);
    expect(m).toMatch(/try again/i);
    expect(m).not.toMatch(/charged/i);
  });

  it('never echoes server text and returns null for anything else', () => {
    for (const body of [{ ok: false, error: '<b>injected</b>' }, { reason: 'otp' }, { reason: 'busy' }, null, 'x', { kyc_required: 'yes' }]) {
      expect(payErrorMessage(body), JSON.stringify(body)).toBeNull();
    }
  });
});

// Step 0 FX-2: the rate refusals get their own copy (never the server text).
describe('payErrorMessage — Step 0 rate refusals', () => {
  it('rate_expired says the transfer was cancelled, nothing charged, and asks for a fresh quote in chat', () => {
    const m = payErrorMessage({ ok: false, reason: 'rate_expired', status: 'cancelled', error: 'x' });
    expect(m).toBe(PAY_RATE_EXPIRED_COPY);
    expect(m).toMatch(/cancelled/);
    expect(m).toMatch(/nothing was charged/);
    expect(m).toMatch(/WhatsApp/);
  });

  it('rate_expired_payment_pending never says cancelled or "nothing was charged"', () => {
    const m = payErrorMessage({ ok: false, reason: 'rate_expired_payment_pending' });
    expect(m).toBe(PAY_RATE_EXPIRED_PAYMENT_PENDING_COPY);
    expect(m).not.toMatch(/cancel/i);
    expect(m).not.toMatch(/nothing was charged/i);
    expect(m).toMatch(/original rate/);
  });

  it('fx_unavailable asks to try again in a few minutes (the rate.ts text)', () => {
    expect(payErrorMessage({ ok: false, reason: 'fx_unavailable' })).toBe(PAY_FX_UNAVAILABLE_COPY);
    expect(PAY_FX_UNAVAILABLE_COPY).toBe(FX_UNAVAILABLE_MESSAGE);
  });

  it('the draft branch quoteExpired wins over fx_unavailable and never says cancelled (N9)', () => {
    const m = payErrorMessage({ ok: false, reason: 'fx_unavailable', quoteExpired: true });
    expect(m).toBe(PAY_QUOTE_EXPIRED_COPY);
    expect(m).not.toBe(PAY_RATE_EXPIRED_COPY);
    expect(m).not.toMatch(/cancel/i);
  });
});

// Fix pack 4 (C14): the reload and approval-not-recorded copies the pay routes answer with.
describe('payErrorMessage: fix pack 4 copy', () => {
  it('reload_required -> PAY_RELOAD_REQUIRED_COPY and approval_not_recorded -> PAY_APPROVAL_NOT_RECORDED_COPY', () => {
    expect(payErrorMessage({ ok: false, reason: 'reload_required', error: 'x' })).toBe(PAY_RELOAD_REQUIRED_COPY);
    expect(payErrorMessage({ ok: false, reason: 'approval_not_recorded', error: 'x' })).toBe(PAY_APPROVAL_NOT_RECORDED_COPY);
  });

  it('the three new constants equal the C14 strings exactly, and PAY_ACCOUNT_HOLDER_COPY is not returned by payErrorMessage', () => {
    expect(PAY_RELOAD_REQUIRED_COPY).toBe('This page is out of date. Reload the page, check the details, then try again. Nothing was charged.');
    expect(PAY_APPROVAL_NOT_RECORDED_COPY).toBe("We couldn't record your approval, so nothing was charged. Tap Resend for a new code, then try again.");
    expect(PAY_ACCOUNT_HOLDER_COPY).toBe("Enter the account holder's name as it appears at the recipient's bank.");
    for (const body of [{ reason: 'account_holder' }, { reason: 'account_holder_required' }, { fieldErrors: { accountHolder: PAY_ACCOUNT_HOLDER_COPY } }]) {
      expect(payErrorMessage(body), JSON.stringify(body)).toBeNull();
    }
  });
});

// Review R1-P1 A1: a funded row's answers carry `funded: true`; the form then
// shows the variant that makes no "nothing was charged" claim.
describe('payErrorMessage: funded variants (review R1-P1 A1)', () => {
  it('funded: true -> the funded copy, which never mentions a charge', () => {
    expect(payErrorMessage({ ok: false, reason: 'reload_required', funded: true })).toBe(PAY_RELOAD_REQUIRED_FUNDED_COPY);
    expect(payErrorMessage({ ok: false, reason: 'approval_not_recorded', funded: true })).toBe(PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY);
    expect(PAY_RELOAD_REQUIRED_FUNDED_COPY).toBe('This page is out of date. Reload the page, check the details, then try again.');
    expect(PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY).toBe("We couldn't record your approval. Tap Resend for a new code, then try again.");
    expect(PAY_RELOAD_REQUIRED_FUNDED_COPY).not.toMatch(/charged/i);
    expect(PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY).not.toMatch(/charged/i);
  });

  it('funded absent or not true -> the existing copy', () => {
    expect(payErrorMessage({ ok: false, reason: 'reload_required', funded: 'yes' })).toBe(PAY_RELOAD_REQUIRED_COPY);
    expect(payErrorMessage({ ok: false, reason: 'approval_not_recorded', funded: false })).toBe(PAY_APPROVAL_NOT_RECORDED_COPY);
  });
});

// Fix pack 4 (C14): the client helper that replaces pay-form's ackField and the
// link form's inline object.
describe('disclosureAckBody', () => {
  const HASH = 'dh1:' + 'a'.repeat(64);

  it('not acked, or no version, is {}', () => {
    expect(disclosureAckBody('2026-10-v1', HASH, false)).toEqual({});
    expect(disclosureAckBody(null, HASH, true)).toEqual({});
    expect(disclosureAckBody(null, null, false)).toEqual({});
  });

  it('acked carries the version, and the hash only when it is a dh1 hash', () => {
    expect(disclosureAckBody('2026-10-v1', null, true)).toEqual({ disclosureVersion: '2026-10-v1' });
    expect(disclosureAckBody('2026-10-v1', HASH, true)).toEqual({ disclosureVersion: '2026-10-v1', disclosureHash: HASH });
    for (const bad of ['', 'dh1:', 'dh1:' + 'A'.repeat(64), 'dh2:' + 'a'.repeat(64), 'dh1:' + 'a'.repeat(63), ' ' + HASH]) {
      expect(disclosureAckBody('2026-10-v1', bad, true), bad).toEqual({ disclosureVersion: '2026-10-v1' });
    }
  });
});

// Fix pack 6 (P4): the E-SIGN consent field a pay form posts: the version only when ticked.
describe('esignConsentBody (fix pack 6 P4)', () => {
  it("ticked with a version -> { esignConsentVersion }; not ticked or no version -> {}", () => {
    expect(esignConsentBody('v', true)).toEqual({ esignConsentVersion: 'v' });
    expect(esignConsentBody('v', false)).toEqual({});
    expect(esignConsentBody(null, true)).toEqual({});
    expect(esignConsentBody(null, false)).toEqual({});
  });
});

// Review R2-Q1 I2: a 409 not_available on the pay POST (the R18 gates, the live controls) shows
// the fixed cannot_complete line on the pay, link and bill forms, never the generic retry text.
describe('payErrorMessage — not_available (R2-Q1 I2)', () => {
  it('maps to PAY_NOT_AVAILABLE_COPY, pinned equal to the server body and fixedReply(cannot_complete)', async () => {
    const { PAY_NOT_AVAILABLE } = await import('@/lib/pay-not-available');
    const { fixedReply } = await import('@/lib/hold-replies');
    const { PAY_NOT_AVAILABLE_COPY } = await import('@/lib/pay-outcome');
    expect(PAY_NOT_AVAILABLE_COPY).toBe(fixedReply('cannot_complete'));
    expect(PAY_NOT_AVAILABLE_COPY).toBe(PAY_NOT_AVAILABLE.body.error);
    expect(payErrorMessage({ ...PAY_NOT_AVAILABLE.body })).toBe(PAY_NOT_AVAILABLE_COPY);
    expect(payErrorMessage({ ok: false, reason: 'not_available', error: 'anything the server said' })).toBe(PAY_NOT_AVAILABLE_COPY);
  });
});

// Review R3-Y2 R1: the B2B bill form's non-OK answer (bill-pay-form.tsx). quote_expired, otp and
// fieldErrors stay the form's own branches; every other parsed body goes through this helper.
describe('billPayErrorOutcome (R3-Y2 R1)', () => {
  it('503 temporarily_unavailable: the temporary copy, and the code is cleared (it may be spent)', async () => {
    const { billPayErrorOutcome } = await import('@/lib/pay-outcome');
    expect(billPayErrorOutcome({ ok: false, reason: 'temporarily_unavailable', error: 'x' })).toEqual({ message: PAY_TEMPORARY_COPY, clearCode: true });
  });
  it('409 not_available: the cannot-complete copy, and the code is cleared', async () => {
    const { billPayErrorOutcome, PAY_NOT_AVAILABLE_COPY } = await import('@/lib/pay-outcome');
    expect(billPayErrorOutcome({ ok: false, reason: 'not_available' })).toEqual({ message: PAY_NOT_AVAILABLE_COPY, clearCode: true });
  });
  it('503 approval_not_recorded: today\'s copy (funded variant too), and the code is cleared', async () => {
    const { billPayErrorOutcome } = await import('@/lib/pay-outcome');
    expect(billPayErrorOutcome({ reason: 'approval_not_recorded' })).toEqual({ message: PAY_APPROVAL_NOT_RECORDED_COPY, clearCode: true });
    expect(billPayErrorOutcome({ reason: 'approval_not_recorded', funded: true })).toEqual({ message: PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY, clearCode: true });
  });
  it('anything else: no message (the form keeps its fallback) and the code stays', async () => {
    const { billPayErrorOutcome } = await import('@/lib/pay-outcome');
    for (const body of [null, 'x', {}, { reason: 'bad_request' }, { reason: 'rate_limited' }, { error: 'server text' }]) {
      expect(billPayErrorOutcome(body), JSON.stringify(body)).toEqual({ message: null, clearCode: false });
    }
  });
});
