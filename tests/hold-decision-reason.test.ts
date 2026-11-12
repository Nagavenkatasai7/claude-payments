import { describe, expect, it } from 'vitest';
import { AML_HOLD_RULES } from '@/lib/aml-rules';
import { boundHoldEvidence, HOLD_EVIDENCE_LIST_MAX, HOLD_REASON_MAX, HOLD_REASON_MIN, parseHoldReason } from '@/lib/hold-decision';
import { isReasonValid } from '@/lib/ui/confirm-reason';
import { isPartnerNoteShaped } from '@/lib/partner-transfers';
import { RISK_SIGNALS } from '@/lib/risk-signals';
import { requireStaffReason, STAFF_REASON_MAX, STAFF_REASON_MIN } from '@/lib/send-limits';

// Fix pack 7 T6 (P7): the ONE free text of pack 7 (the decision reason) and
// the closed evidence bounds.

/** The partner release action's sequence (release-actions.ts), copied as-is. */
function releaseActionAnswer(raw: unknown): { ok: true; reason: string } | { ok: false; code: 'short' | 'number' } {
  let reason: string;
  try {
    if (!isReasonValid(raw, STAFF_REASON_MIN)) throw new Error('short');
    reason = requireStaffReason(raw);
  } catch {
    return { ok: false, code: 'short' };
  }
  if (!isPartnerNoteShaped(reason)) return { ok: false, code: 'number' };
  return { ok: true, reason };
}

describe('parseHoldReason (P7)', () => {
  it('HOLD_REASON_MIN === 10 and HOLD_REASON_MAX === 500 (= STAFF_REASON_MIN/MAX)', () => {
    expect(HOLD_REASON_MIN).toBe(10);
    expect(HOLD_REASON_MAX).toBe(500);
    expect(HOLD_REASON_MIN).toBe(STAFF_REASON_MIN);
    expect(HOLD_REASON_MAX).toBe(STAFF_REASON_MAX);
  });

  const emoji10 = '😀'.repeat(10);
  const CASES: Array<[string, unknown, ReturnType<typeof parseHoldReason>]> = [
    ['undefined', undefined, { ok: false, code: 'short' }],
    ['a number', 42, { ok: false, code: 'short' }],
    ['a File', new File(['ten chars!!'], 'x.txt'), { ok: false, code: 'short' }],
    ['empty', '', { ok: false, code: 'short' }],
    ['short', 'short', { ok: false, code: 'short' }],
    ['nine characters plus padding', '   123456789   ', { ok: false, code: 'short' }],
    ['a 10-code-point emoji string', emoji10, { ok: true, reason: emoji10 }],
    ['a 10-digit run', 'Reference 1234567890 checked', { ok: false, code: 'number' }],
    ['separators are ignored', '1234-567-890 noted', { ok: false, code: 'number' }],
    ['control characters are collapsed', 'Documents\u0000\u0007 checked\n\tok', { ok: true, reason: 'Documents checked ok' }],
  ];
  it.each(CASES)('%s', (_n, raw, want) => {
    expect(parseHoldReason(raw)).toEqual(want);
    expect(parseHoldReason(raw)).toEqual(releaseActionAnswer(raw));
  });

  it('a 700-character reason is ok, cut to 500', () => {
    const r = parseHoldReason('a'.repeat(700));
    expect(r).toEqual({ ok: true, reason: 'a'.repeat(500) });
    expect(r).toEqual(releaseActionAnswer('a'.repeat(700)));
  });
});

describe('boundHoldEvidence (P7)', () => {
  it('non-object input -> {}', () => {
    for (const v of [null, undefined, 1, 'x', true, [1, 2]]) expect(boundHoldEvidence(v)).toEqual({});
  });

  it('unknown keys are dropped', () => {
    expect(boundHoldEvidence({ listSource: 'ofac-sdn', inputHash: 'h', name: 'Jane Doe', phone: '+15550000000', listHash: 'x' }))
      .toEqual({ listSource: 'ofac-sdn' });
  });

  it('listSource and listVersion: cut to 128, dropped when not strings or empty', () => {
    const e = boundHoldEvidence({ listSource: 's'.repeat(200), listVersion: 7 });
    expect(e).toEqual({ listSource: 's'.repeat(128) });
    expect(boundHoldEvidence({ listVersion: 'v-2026-11' })).toEqual({ listVersion: 'v-2026-11' });
    expect(boundHoldEvidence({ listSource: '' })).toEqual({});
  });

  it('screenedAt kept only when Date.parse is finite (as ISO)', () => {
    const iso = new Date(Date.now() - 3_600_000).toISOString();
    expect(boundHoldEvidence({ screenedAt: iso })).toEqual({ screenedAt: iso });
    expect(boundHoldEvidence({ screenedAt: 'not a date' })).toEqual({});
    expect(boundHoldEvidence({ screenedAt: 123 })).toEqual({});
  });

  it('maxScore kept only when finite and in [0, 1]', () => {
    expect(boundHoldEvidence({ maxScore: 0.87 })).toEqual({ maxScore: 0.87 });
    expect(boundHoldEvidence({ maxScore: 0 })).toEqual({ maxScore: 0 });
    expect(boundHoldEvidence({ maxScore: 1 })).toEqual({ maxScore: 1 });
    for (const v of [1.01, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) expect(boundHoldEvidence({ maxScore: v })).toEqual({});
  });

  it('matchedEntryIds: shaped ids (<= 64 chars) only, at most HOLD_EVIDENCE_LIST_MAX (20), de-duplicated in order', () => {
    expect(HOLD_EVIDENCE_LIST_MAX).toBe(20);
    const ids = Array.from({ length: 30 }, (_, n) => `sdn:${n}`);
    expect(boundHoldEvidence({ matchedEntryIds: ids }).matchedEntryIds).toEqual(ids.slice(0, 20));
    expect(boundHoldEvidence({ matchedEntryIds: ['sdn:36', 'bad id', 'x'.repeat(65), 'un-sc:QDi.1/a#b', 7, 'sdn:36'] }))
      .toEqual({ matchedEntryIds: ['sdn:36', 'un-sc:QDi.1/a#b'] });
    expect(boundHoldEvidence({ matchedEntryIds: ['bad id'] })).toEqual({});
    expect(boundHoldEvidence({ matchedEntryIds: 'sdn:36' })).toEqual({});
  });

  it('amlKinds, amlRules, riskSignals and scamCategory are intersected with their closed sets, de-duplicated, in order', () => {
    expect(boundHoldEvidence({
      amlKinds: ['risk_signal', 'nope', 'aml_rule', 'risk_signal'],
      amlRules: ['structuring', 'cluster', 'structuring', ...AML_HOLD_RULES],
      riskSignals: ['chat_cue', 'velocity', ...RISK_SIGNALS],
      scamCategory: 'romance',
    })).toEqual({
      amlKinds: ['risk_signal', 'aml_rule'],
      amlRules: ['structuring', 'first_transfer', 'new_beneficiary'],
      riskSignals: ['chat_cue', 'first_to_recipient', 'first_transfer', 'new_account', 'amount_over_threshold'],
      scamCategory: 'romance',
    });
    expect(boundHoldEvidence({ scamCategory: 'lottery' })).toEqual({});
    expect(boundHoldEvidence({ amlKinds: ['nope'], amlRules: [], riskSignals: 'chat_cue' })).toEqual({});
  });

  it('the output never holds a key outside HoldReviewEvidence (deep scan for inputHash, listHash, name, phone)', () => {
    const out = boundHoldEvidence({
      listSource: 'ofac-sdn', listVersion: 'v1', screenedAt: new Date().toISOString(), maxScore: 0.5,
      matchedEntryIds: ['sdn:1'], amlKinds: ['aml_rule'], amlRules: ['structuring'], riskSignals: ['chat_cue'], scamCategory: 'job',
      inputHash: 'abc', listHash: 'def', name: 'Jane', phone: '+15550000000', nested: { name: 'x' },
    });
    const ALLOWED = ['listSource', 'listVersion', 'screenedAt', 'maxScore', 'matchedEntryIds', 'amlKinds', 'amlRules', 'riskSignals', 'scamCategory'];
    expect(Object.keys(out).every((k) => ALLOWED.includes(k))).toBe(true);
    const json = JSON.stringify(out);
    for (const bad of ['inputHash', 'listHash', '"name"', 'phone', 'Jane', '+1555']) expect(json).not.toContain(bad);
    for (const v of Object.values(out)) expect(typeof v === 'object' && v !== null ? Array.isArray(v) : true).toBe(true);
  });
});
