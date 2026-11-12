import { describe, it, expect } from 'vitest';
import { KYC_EDD_NOTE_MAX, parseKycExtraMeta, sanitizeKycExtraMeta } from '@/lib/partner-kyc-decision';

// Fix pack 7 T24 (P22): what a partner KYC decision must carry. Pure; FormData built here.

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('parseKycExtraMeta: flagged decisions', () => {
  it("flagged approve needs disposition false_positive or pep_accepted_with_edd: missing or 'reject' -> { ok: false, code: 'disposition' }", () => {
    expect(parseKycExtraMeta(fd({}), 'approve', true)).toEqual({ ok: false, code: 'disposition' });
    expect(parseKycExtraMeta(fd({ disposition: 'reject' }), 'approve', true)).toEqual({ ok: false, code: 'disposition' });
    expect(parseKycExtraMeta(fd({ disposition: 'bogus' }), 'approve', true)).toEqual({ ok: false, code: 'disposition' });
    expect(parseKycExtraMeta(fd({ disposition: 'false_positive' }), 'approve', true)).toEqual({ ok: true, meta: { disposition: 'false_positive' } });
  });

  it("flagged reject needs 'reject'", () => {
    expect(parseKycExtraMeta(fd({}), 'reject', true)).toEqual({ ok: false, code: 'disposition' });
    expect(parseKycExtraMeta(fd({ disposition: 'false_positive' }), 'reject', true)).toEqual({ ok: false, code: 'disposition' });
    expect(parseKycExtraMeta(fd({ disposition: 'pep_accepted_with_edd', eddDone: 'on' }), 'reject', true)).toEqual({ ok: false, code: 'disposition' });
    expect(parseKycExtraMeta(fd({ disposition: 'reject' }), 'reject', true)).toEqual({ ok: true, meta: { disposition: 'reject' } });
  });

  it("pep_accepted_with_edd without eddDone -> 'edd_required'; with eddDone 'on' (or 'true') -> { disposition, eddDone: true }", () => {
    expect(parseKycExtraMeta(fd({ disposition: 'pep_accepted_with_edd' }), 'approve', true)).toEqual({ ok: false, code: 'edd_required' });
    expect(parseKycExtraMeta(fd({ disposition: 'pep_accepted_with_edd', eddDone: 'yes' }), 'approve', true)).toEqual({ ok: false, code: 'edd_required' });
    expect(parseKycExtraMeta(fd({ disposition: 'pep_accepted_with_edd', eddDone: 'on' }), 'approve', true)).toEqual({ ok: true, meta: { disposition: 'pep_accepted_with_edd', eddDone: true } });
    expect(parseKycExtraMeta(fd({ disposition: 'pep_accepted_with_edd', eddDone: 'true' }), 'approve', true)).toEqual({ ok: true, meta: { disposition: 'pep_accepted_with_edd', eddDone: true } });
  });

  it("eddNote: trimmed; '' dropped; 281 chars -> 'note_long'; a 10-digit run -> 'note_number'; kept only with eddDone", () => {
    const base = { disposition: 'pep_accepted_with_edd', eddDone: 'on' };
    expect(parseKycExtraMeta(fd({ ...base, eddNote: '  source of funds checked  ' }), 'approve', true))
      .toEqual({ ok: true, meta: { disposition: 'pep_accepted_with_edd', eddDone: true, eddNote: 'source of funds checked' } });
    expect(parseKycExtraMeta(fd({ ...base, eddNote: '   ' }), 'approve', true))
      .toEqual({ ok: true, meta: { disposition: 'pep_accepted_with_edd', eddDone: true } });
    expect(KYC_EDD_NOTE_MAX).toBe(280);
    expect(parseKycExtraMeta(fd({ ...base, eddNote: 'a'.repeat(280) }), 'approve', true).ok).toBe(true);
    expect(parseKycExtraMeta(fd({ ...base, eddNote: 'a'.repeat(281) }), 'approve', true)).toEqual({ ok: false, code: 'note_long' });
    expect(parseKycExtraMeta(fd({ ...base, eddNote: 'called 5551234567 today' }), 'approve', true)).toEqual({ ok: false, code: 'note_number' });
    expect(parseKycExtraMeta(fd({ ...base, eddNote: 'acct 555-123-4567' }), 'approve', true)).toEqual({ ok: false, code: 'note_number' });
    // Without eddDone the note is dropped (false_positive approve).
    expect(parseKycExtraMeta(fd({ disposition: 'false_positive', eddNote: 'not the same person' }), 'approve', true))
      .toEqual({ ok: true, meta: { disposition: 'false_positive' } });
  });
});

describe('parseKycExtraMeta: unflagged decisions', () => {
  it('a posted disposition is dropped; eddDone and eddNote are kept', () => {
    expect(parseKycExtraMeta(fd({ disposition: 'false_positive' }), 'approve', false)).toEqual({ ok: true, meta: {} });
    expect(parseKycExtraMeta(fd({ disposition: 'bogus' }), 'reject', false)).toEqual({ ok: true, meta: {} });
    expect(parseKycExtraMeta(fd({ disposition: 'reject', eddDone: 'on', eddNote: ' docs reviewed ' }), 'approve', false))
      .toEqual({ ok: true, meta: { eddDone: true, eddNote: 'docs reviewed' } });
    expect(parseKycExtraMeta(fd({ eddNote: 'docs reviewed' }), 'approve', false)).toEqual({ ok: true, meta: {} });
    expect(parseKycExtraMeta(fd({ eddDone: 'on', eddNote: 'x'.repeat(281) }), 'approve', false)).toEqual({ ok: false, code: 'note_long' });
  });

  it('the result never carries a key outside disposition, eddDone, eddNote', () => {
    const f = fd({ disposition: 'false_positive', eddDone: 'on', eddNote: 'ok', reason: 'r', extra: 'x', __proto__: 'p' });
    const r = parseKycExtraMeta(f, 'approve', true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.meta).sort()).toEqual(['disposition', 'eddDone', 'eddNote']);
  });
});

describe('sanitizeKycExtraMeta', () => {
  it('drops unknown keys, a non-enum disposition, eddDone other than true, a long or number-shaped note; returns {} for null/undefined/arrays', () => {
    expect(sanitizeKycExtraMeta(null)).toEqual({});
    expect(sanitizeKycExtraMeta(undefined)).toEqual({});
    expect(sanitizeKycExtraMeta([])).toEqual({});
    expect(sanitizeKycExtraMeta(['false_positive'])).toEqual({});
    expect(sanitizeKycExtraMeta('false_positive')).toEqual({});
    expect(sanitizeKycExtraMeta({ disposition: 'false_positive', eddDone: true, eddNote: 'ok', reason: 'x', phone: '+15551234567' }))
      .toEqual({ disposition: 'false_positive', eddDone: true, eddNote: 'ok' });
    expect(sanitizeKycExtraMeta({ disposition: 'approve' })).toEqual({});
    expect(sanitizeKycExtraMeta({ eddDone: 'on' })).toEqual({});
    expect(sanitizeKycExtraMeta({ eddDone: 1 })).toEqual({});
    expect(sanitizeKycExtraMeta({ eddDone: true, eddNote: 'a'.repeat(281) })).toEqual({ eddDone: true });
    expect(sanitizeKycExtraMeta({ eddDone: true, eddNote: 'ref 1234567890' })).toEqual({ eddDone: true });
    expect(sanitizeKycExtraMeta({ eddDone: true, eddNote: 42 })).toEqual({ eddDone: true });
    expect(sanitizeKycExtraMeta({ eddDone: true, eddNote: '  ' })).toEqual({ eddDone: true });
  });

  it('a note without eddDone is dropped (the same rule as the parser)', () => {
    expect(sanitizeKycExtraMeta({ disposition: 'reject', eddNote: 'ok' })).toEqual({ disposition: 'reject' });
  });
});
