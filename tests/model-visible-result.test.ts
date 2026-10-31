import { describe, it, expect } from 'vitest';
import { MODEL_HIDDEN_KEYS, modelVisibleResult } from '@/lib/model-visible-result';

// R30 (no tipping-off): the last gate before a tool result enters the model's
// history. The tools already leave these fields out; this strips them again so
// a future tool (or a nested cap_eval) can never hand the model a remaining
// figure, the EDD threshold or a screening result to repeat to the customer.
describe('modelVisibleResult', () => {
  it('names the fields R30 keeps away from the model', () => {
    for (const k of ['today_remaining_usd', 'today_used_usd', 'remaining_today_usd', 'edd_threshold_usd', 'compliance_status', 'compliance_reasons']) {
      expect(MODEL_HIDDEN_KEYS.has(k), k).toBe(true);
    }
  });

  it('drops the hidden keys at the top level and keeps everything else in order', () => {
    const out = modelVisibleResult({ within_cap: false, today_remaining_usd: 134, reason: 'over_daily_cap', edd_threshold_usd: 3000, reply_to_customer: 'x' });
    expect(out).toEqual({ within_cap: false, reason: 'over_daily_cap', reply_to_customer: 'x' });
    expect(Object.keys(out)).toEqual(['within_cap', 'reason', 'reply_to_customer']);
  });

  it('drops them inside nested objects and arrays (cap_eval, lists)', () => {
    const out = modelVisibleResult({
      error: 'Cap exceeded for this transfer.',
      cap_eval: { tier: 'T0', today_used_usd: 300, today_remaining_usd: 200, inner: [{ compliance_status: 'flagged', id: 'a' }] },
      transfers: [{ id: 't1', compliance_reasons: ['watchlist'] }],
    });
    expect(out).toEqual({
      error: 'Cap exceeded for this transfer.',
      cap_eval: { tier: 'T0', inner: [{ id: 'a' }] },
      transfers: [{ id: 't1' }],
    });
  });

  it('never mutates its input', () => {
    const input = { today_remaining_usd: 1, nested: { today_used_usd: 2 } };
    modelVisibleResult(input);
    expect(input).toEqual({ today_remaining_usd: 1, nested: { today_used_usd: 2 } });
  });

  it('passes primitives, null and a clean result through unchanged', () => {
    const clean = { transfer_id: 'abc', status: 'paid', n: 1, ok: true, none: null, list: ['a', 2] };
    expect(modelVisibleResult(clean)).toEqual(clean);
  });

  it('R32: the code-written quote_text is for the customer, never the model (it cannot copy or reword it)', () => {
    expect(MODEL_HIDDEN_KEYS.has('quote_text')).toBe(true);
    const out = modelVisibleResult({ amount_source: 500, quote_text: 'Sending $500.00.\nFee $1.99', delivery_estimate: 'within 1 business day' });
    expect(out).toEqual({ amount_source: 500, delivery_estimate: 'within 1 business day' });
  });
});
