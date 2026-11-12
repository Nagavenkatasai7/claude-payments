// Fix pack 6 (P13): the closed list of in-mint AML rules a corridor may hold
// on. Defined in the pure aml-rules.ts (no cycle with compliance-config) and
// re-exported from aml-hold.ts, where later tasks import it.
import { describe, it, expect } from 'vitest';
import { AML_HOLD_RULES, isAmlHoldRule } from '@/lib/aml-hold';
import * as rules from '@/lib/aml-rules';
import { isAmlRule } from '@/lib/aml-rules';

describe('AML_HOLD_RULES (pack 6 P13)', () => {
  it("AML_HOLD_RULES is frozen and equals ['structuring', 'first_transfer', 'new_beneficiary']", () => {
    expect(Object.isFrozen(AML_HOLD_RULES)).toBe(true);
    expect([...AML_HOLD_RULES]).toEqual(['structuring', 'first_transfer', 'new_beneficiary']);
  });
  it("isAmlHoldRule: true for the three; false for 'cluster', '', 'STRUCTURING', null, 1", () => {
    for (const r of ['structuring', 'first_transfer', 'new_beneficiary']) expect(isAmlHoldRule(r)).toBe(true);
    for (const v of ['cluster', '', 'STRUCTURING', null, 1, undefined, {}]) expect(isAmlHoldRule(v)).toBe(false);
  });
  it('every AmlHoldRule is an AmlRule', () => {
    expect(AML_HOLD_RULES.every(isAmlRule)).toBe(true);
  });
  it('aml-hold.ts re-exports the same objects as aml-rules.ts', () => {
    expect(AML_HOLD_RULES).toBe(rules.AML_HOLD_RULES);
    expect(isAmlHoldRule).toBe(rules.isAmlHoldRule);
  });
});
