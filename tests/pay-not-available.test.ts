import { describe, expect, it } from 'vitest';
import { PAY_NOT_AVAILABLE, payNotAvailable } from '@/lib/pay-not-available';
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
