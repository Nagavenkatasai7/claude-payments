import { describe, expect, it } from 'vitest';
import {
  PAY_NOT_AVAILABLE,
  payAccountHolderInvalid,
  payApprovalNotRecorded,
  payNotAvailable,
  payReloadRequired,
  payTemporarilyUnavailable,
  transferFunded,
} from '@/lib/pay-not-available';
import {
  PAY_ACCOUNT_HOLDER_COPY,
  PAY_APPROVAL_NOT_RECORDED_COPY,
  PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY,
  PAY_RELOAD_REQUIRED_COPY,
  PAY_RELOAD_REQUIRED_FUNDED_COPY,
  PAY_TEMPORARY_COPY,
  payErrorMessage,
} from '@/lib/pay-outcome';
import { fixedReply } from '@/lib/hold-replies';

// Contract 5 (pack 3): the one neutral answer a pay route gives when a live
// control refused the mint. Nothing names the reason (no certification, rail,
// capability or counsel text): the customer sees the cannot_complete line.
describe('PAY_NOT_AVAILABLE (pack 3)', () => {
  it('PAY_NOT_AVAILABLE is 409 with the cannot_complete text and reason not_available', () => {
    expect(PAY_NOT_AVAILABLE).toEqual({
      status: 409,
      body: { ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' },
    });
    expect(Object.isFrozen(PAY_NOT_AVAILABLE)).toBe(true);
    expect(Object.isFrozen(PAY_NOT_AVAILABLE.body)).toBe(true);
  });

  it('payNotAvailable() returns that response', async () => {
    const res = payNotAvailable();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: fixedReply('cannot_complete'),
      reason: 'not_available',
    });
  });

  it('each call is a fresh response (a body is read once)', async () => {
    const a = payNotAvailable();
    const b = payNotAvailable();
    expect(a).not.toBe(b);
    await a.json();
    expect(await b.json()).toEqual({ ...PAY_NOT_AVAILABLE.body });
  });
});

// Fix pack 4 T8 (C8, C10): the R18 reload answer and the evidence-not-recorded answer.
describe('payReloadRequired / payApprovalNotRecorded (pack 4)', () => {
  it('payReloadRequired() is 409 reload_required with the reload copy', async () => {
    const res = payReloadRequired();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
  });

  it('payApprovalNotRecorded() is 503 approval_not_recorded with the approval copy', async () => {
    const res = payApprovalNotRecorded();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
  });

  it('each call is a fresh response', async () => {
    const a = payReloadRequired();
    const b = payReloadRequired();
    expect(a).not.toBe(b);
    await a.json();
    expect((await b.json()).reason).toBe('reload_required');
    expect(payApprovalNotRecorded()).not.toBe(payApprovalNotRecorded());
  });
});

// Review R1-P1 A1: an awaiting row that is already funded (a capture recorded, a
// bank debit bound or settled) never hears "nothing was charged".
describe('transferFunded + the funded variants (review R1-P1 A1)', () => {
  it('true for a fundingRef, a bound intent, and a pending or succeeded fundingState; false for an unfunded row', () => {
    expect(transferFunded({ fundingRef: 'ch_1' })).toBe(true);
    expect(transferFunded({ fundingIntentRef: 'pi_1', fundingState: 'pending' })).toBe(true);
    expect(transferFunded({ fundingIntentRef: 'pi_1' })).toBe(true);
    expect(transferFunded({ fundingState: 'pending' })).toBe(true);
    expect(transferFunded({ fundingState: 'succeeded' })).toBe(true);
    expect(transferFunded({})).toBe(false);
    expect(transferFunded({ fundingState: 'failed' })).toBe(false);
  });

  it('funded: the same reason and status, a reason-free funded flag, and text with no "charged" claim', async () => {
    const r = payReloadRequired(true);
    expect(r.status).toBe(409);
    const rb = await r.json();
    expect(rb).toEqual({ ok: false, reason: 'reload_required', funded: true, error: PAY_RELOAD_REQUIRED_FUNDED_COPY });
    expect(rb.error).not.toMatch(/charged/i);
    const a = payApprovalNotRecorded(true);
    expect(a.status).toBe(503);
    const ab = await a.json();
    expect(ab).toEqual({ ok: false, reason: 'approval_not_recorded', funded: true, error: PAY_APPROVAL_NOT_RECORDED_FUNDED_COPY });
    expect(ab.error).not.toMatch(/charged/i);
  });

  it('unfunded (false or omitted): the existing body, unchanged', async () => {
    expect(await payReloadRequired(false).json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(await payApprovalNotRecorded(false).json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
  });
});

// Fix pack 4 T15 (C14, C18): the account-holder field error.
describe('payAccountHolderInvalid (pack 4 T15)', () => {
  it('is 400 with the fixed error and the account-holder field copy', async () => {
    const res = payAccountHolderInvalid();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Please check the account holder name.',
      fieldErrors: { accountHolder: PAY_ACCOUNT_HOLDER_COPY },
    });
    expect(payAccountHolderInvalid()).not.toBe(payAccountHolderInvalid());
  });
});

// Fix pack 6 T4 (P5): the routes' 503 for an infrastructure fault, as one helper.
describe('payTemporarilyUnavailable (pack 6 P5)', () => {
  it("is 503 { ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable' } (fresh body on each call)", async () => {
    const a = payTemporarilyUnavailable();
    const b = payTemporarilyUnavailable();
    expect(a).not.toBe(b);
    expect(a.status).toBe(503);
    expect(await a.json()).toEqual({
      ok: false,
      error: 'Temporary problem. Please try again in a moment.',
      reason: 'temporarily_unavailable',
    });
    expect(b.status).toBe(503);
    expect((await b.json()).reason).toBe('temporarily_unavailable');
  });

  it('payErrorMessage of that body is PAY_TEMPORARY_COPY (old JS reads it)', async () => {
    expect(payErrorMessage(await payTemporarilyUnavailable().json())).toBe(PAY_TEMPORARY_COPY);
  });
});
