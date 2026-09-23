import { describe, it, expect } from 'vitest';
import { payOkStatus } from '@/lib/pay-outcome';

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
