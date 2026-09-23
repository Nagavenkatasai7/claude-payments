import { describe, it, expect } from 'vitest';
import {
  canDecideApplication,
  parseDecisionReason,
  DECISION_REASON_MAX,
  isPartnerRequestId,
  wizardPrefillFromRequest,
} from '@/lib/partner-application-decision';

// Program-Fix 49C (partner-02): the pure rules behind the staff decision.

describe('partner-application-decision', () => {
  it('only a completed (submitted) application can be decided', () => {
    expect(canDecideApplication('completed')).toBe(true);
    for (const s of ['invited', 'approved', 'rejected', undefined, '', 'COMPLETED']) {
      expect(canDecideApplication(s)).toBe(false);
    }
  });

  it('the reason is required, trimmed and length-bounded', () => {
    expect(parseDecisionReason(null)).toBeNull();
    expect(parseDecisionReason('   ')).toBeNull();
    expect(parseDecisionReason('  ok  ')).toBe('ok');
    expect(parseDecisionReason('x'.repeat(DECISION_REASON_MAX + 50))).toHaveLength(DECISION_REASON_MAX);
  });

  it('partner request ids are validated by shape', () => {
    expect(isPartnerRequestId('preq_Ab_9-Cd')).toBe(true);
    expect(isPartnerRequestId("x' OR 1=1")).toBe(false);
    expect(isPartnerRequestId('')).toBe(false);
  });

  it('wizard prefill: company name, and only the wizard\'s source countries (fallback US)', () => {
    const allowed = ['US', 'CA', 'GB'] as const;
    expect(wizardPrefillFromRequest({ companyName: 'Acme Remit', corridors: ['CA', 'IN', 'Other', 'GB'] }, allowed)).toEqual({
      name: 'Acme Remit',
      countries: ['CA', 'GB'],
    });
    expect(wizardPrefillFromRequest({ companyName: 'Acme', corridors: ['IN'] }, allowed).countries).toEqual(['US']);
    expect(wizardPrefillFromRequest({ companyName: 'x'.repeat(300), corridors: [] }, allowed).name).toHaveLength(120);
  });
});
