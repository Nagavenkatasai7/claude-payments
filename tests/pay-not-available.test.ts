import { describe, expect, it } from 'vitest';
import {
  PAY_NOT_AVAILABLE,
  payAccountHolderInvalid,
  payApprovalNotRecorded,
  payNotAvailable,
  payReloadRequired,
} from '@/lib/pay-not-available';
import { PAY_ACCOUNT_HOLDER_COPY, PAY_APPROVAL_NOT_RECORDED_COPY, PAY_RELOAD_REQUIRED_COPY } from '@/lib/pay-outcome';
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
