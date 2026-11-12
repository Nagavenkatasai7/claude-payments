import { describe, it, expect } from 'vitest';
import {
  AML_HOLD_REASON,
  AML_HOLD_RULES,
  amlHoldGate,
  amlHoldHits,
  type AmlHoldRule,
  applyAmlHold,
  applyPurposeHold,
  addHoldReason,
  amlHoldRulesEntry,
  amlHoldRulesSummary,
  hasAmlHoldEntry,
} from '@/lib/aml-hold';
import { resolveAmlHoldRules } from '@/lib/compliance-config';
import { AML_DEFAULTS, type SenderAmlStats } from '@/lib/aml-rules';
import type { PriorSends } from '@/db/repos/transfer-repo';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

// Program-Fix 43 PR B: the optional per-partner AML hold, as PURE decisions.
// Owner decision (binding): AML rules raise alerts only; a hard hold comes
// ONLY from a per-partner setting that is OFF by default, and a demo transfer
// (the default tenant, or anything that is not real money) is NEVER held.

const cfg = { ...AML_DEFAULTS, largeAmountUsd: 1000 };
const none: SenderAmlStats = { bandCount7d: 0, subTSumCents30d: 0, subTCount30d: 0, priorCount: 0 };
const seasoned: SenderAmlStats = { bandCount7d: 0, subTSumCents30d: 0, subTCount30d: 5, priorCount: 5 };

describe('amlHoldGate (the pre-read gate: false ⇒ zero AML statements)', { retry: 0 }, () => {
  const on = { realMoney: true, amlHolds: true, partnerId: 'acme', railPartnerId: 'acme', complianceStatus: 'cleared' as const };

  it('setting ON, real money, a non-default tenant, a cleared verdict ⇒ run the check', () => {
    expect(amlHoldGate(on)).toBe(true);
  });

  it('not real money (sandbox, simulator, mock) => never', () => {
    expect(amlHoldGate({ ...on, realMoney: false })).toBe(false);
    expect(amlHoldGate({ ...on, realMoney: 'true' as unknown as boolean })).toBe(false);
  });

  it('setting OFF (the default) ⇒ never', () => {
    expect(amlHoldGate({ ...on, amlHolds: false })).toBe(false);
  });

  it('the default (demo) tenant is NEVER held, even with the setting forced ON', () => {
    expect(amlHoldGate({ ...on, partnerId: DEFAULT_PARTNER_ID, railPartnerId: DEFAULT_PARTNER_ID })).toBe(false);
    expect(amlHoldGate({ ...on, partnerId: DEFAULT_PARTNER_ID })).toBe(false);
  });

  it('a transfer routed to settle on the default tenant is never held', () => {
    expect(amlHoldGate({ ...on, railPartnerId: DEFAULT_PARTNER_ID })).toBe(false);
  });

  it('a flagged verdict still runs the check; a blocked one never', () => {
    expect(amlHoldGate({ ...on, complianceStatus: 'flagged' })).toBe(true);
    expect(amlHoldGate({ ...on, complianceStatus: 'blocked' })).toBe(false);
  });

  it('only a literal true switches it on', () => {
    expect(amlHoldGate({ ...on, amlHolds: 'true' as unknown as boolean })).toBe(false);
    expect(amlHoldGate({ ...on, amlHolds: 1 as unknown as boolean })).toBe(false);
  });
});

describe('amlHoldHits (pack 6 P16)', { retry: 0 }, () => {
  const all = AML_HOLD_RULES;
  const hits = (stats: SenderAmlStats, sends: PriorSends, amountUsd: number, rules: readonly AmlHoldRule[] = all) =>
    amlHoldHits({ stats, sends, amountUsd, cfg, rules }).map((h) => h.rule);

  it('first-ever paid send $600 -> [first_transfer] only, even with toRecipient 0', () => {
    expect(hits(none, { total: 0, toRecipient: 0 }, 600)).toEqual(['first_transfer']);
  });

  it('total 2, toRecipient 0, $600 -> [new_beneficiary]', () => {
    expect(hits(seasoned, { total: 2, toRecipient: 0 }, 600)).toEqual(['new_beneficiary']);
  });

  it('total 2, toRecipient null (no recipient phone) -> []', () => {
    expect(hits(seasoned, { total: 2, toRecipient: null }, 600)).toEqual([]);
  });

  it('total 2, toRecipient 1 -> []', () => {
    expect(hits(seasoned, { total: 2, toRecipient: 1 }, 600)).toEqual([]);
  });

  it('stats.priorCount 5 but sends.total 0 -> first_transfer (unpaid rows no longer defeat it)', () => {
    expect(hits(seasoned, { total: 0, toRecipient: 0 }, 600)).toEqual(['first_transfer']);
  });

  it('bandCount7d 2, $900, total 3, toRecipient 0 -> [structuring, new_beneficiary] (order)', () => {
    expect(hits({ ...seasoned, bandCount7d: 2 }, { total: 3, toRecipient: 0 }, 900)).toEqual(['structuring', 'new_beneficiary']);
  });

  it('rules without first_transfer, first-ever -> [] (Q17)', () => {
    expect(hits(none, { total: 0, toRecipient: 0 }, 600, ['structuring', 'new_beneficiary'])).toEqual([]);
  });

  it('rules [] -> []', () => {
    expect(hits({ ...seasoned, bandCount7d: 2 }, { total: 3, toRecipient: 0 }, 900, [])).toEqual([]);
  });

  it('$200 first-ever -> []', () => {
    expect(hits(none, { total: 0, toRecipient: 0 }, 200)).toEqual([]);
  });
});

describe('applyAmlHold (cleared → flagged is the ONLY change)', { retry: 0 }, () => {
  const hit = { rule: 'first_transfer' as const, window: 'first' as const, count: 1, sumUsd: 600 };

  it('a hit on a cleared verdict flags it with the generic reason only', () => {
    expect(applyAmlHold({ complianceStatus: 'cleared', complianceReasons: [] }, hit)).toEqual({
      complianceStatus: 'flagged',
      complianceReasons: [AML_HOLD_REASON],
    });
  });

  it('the reason never names the rule (no tipping off)', () => {
    expect(AML_HOLD_REASON).toBe('Additional review required.');
    expect(AML_HOLD_REASON.toLowerCase()).not.toMatch(/aml|structur|first|beneficiar|cluster|launder/);
  });

  it('no hit ⇒ unchanged', () => {
    const v = { complianceStatus: 'cleared' as const, complianceReasons: [] as string[] };
    expect(applyAmlHold(v, null)).toBe(v);
  });

  it('a flagged verdict gains the reason once; a blocked verdict is never touched', () => {
    const flagged = { complianceStatus: 'flagged' as const, complianceReasons: ['Large transfer amount.'] };
    const blocked = { complianceStatus: 'blocked' as const, complianceReasons: ['Recipient matched watchlist.'] };
    expect(applyAmlHold(flagged, hit)).toEqual({
      complianceStatus: 'flagged',
      complianceReasons: ['Large transfer amount.', AML_HOLD_REASON],
    });
    expect(applyAmlHold(blocked, hit)).toBe(blocked);
    expect(applyAmlHold(flagged, null)).toBe(flagged);
  });
});

// Batch B follow-up A4: the purpose hold takes the same verdict path (no gate: owner decision 2026-10-08).
describe('applyPurposeHold', { retry: 0 }, () => {
  it('a risk category flags a cleared verdict with the generic reason only', () => {
    expect(applyPurposeHold({ complianceStatus: 'cleared', complianceReasons: [] }, 'prize')).toEqual({
      complianceStatus: 'flagged',
      complianceReasons: [AML_HOLD_REASON],
    });
  });

  it('no risk ⇒ unchanged; a flagged verdict gains the reason once; a blocked verdict is never touched', () => {
    const v = { complianceStatus: 'cleared' as const, complianceReasons: [] as string[] };
    const flagged = { complianceStatus: 'flagged' as const, complianceReasons: ['Large transfer amount.'] };
    const blocked = { complianceStatus: 'blocked' as const, complianceReasons: ['Recipient matched watchlist.'] };
    expect(applyPurposeHold(v, undefined)).toBe(v);
    expect(applyPurposeHold(flagged, undefined)).toBe(flagged);
    expect(applyPurposeHold(flagged, 'prize')).toEqual({
      complianceStatus: 'flagged',
      complianceReasons: ['Large transfer amount.', AML_HOLD_REASON],
    });
    expect(applyPurposeHold(blocked, 'prize')).toBe(blocked);
  });
});

// Fix pack 6 (P15): the ONE hold verdict. A flagged row keeps its own reasons and
// gains the generic one, so the strictest release authority wins (a scam-pattern
// row flagged for amount is no longer partner-releasable).
describe('addHoldReason (pack 6 P15)', { retry: 0 }, () => {
  it('cleared [] -> flagged [AML_HOLD_REASON]', () => {
    expect(addHoldReason({ complianceStatus: 'cleared', complianceReasons: [] })).toEqual({
      complianceStatus: 'flagged',
      complianceReasons: [AML_HOLD_REASON],
    });
  });

  it('flagged keeps its reasons in order and gains the generic reason last', () => {
    expect(addHoldReason({ complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] })).toEqual({
      complianceStatus: 'flagged',
      complianceReasons: ['Large transfer amount.', AML_HOLD_REASON],
    });
  });

  it('a verdict already carrying the reason is not given it twice', () => {
    const v = { complianceStatus: 'flagged' as const, complianceReasons: ['Large transfer amount.', AML_HOLD_REASON] };
    const out = addHoldReason(v);
    expect(out.complianceStatus).toBe('flagged');
    expect(out.complianceReasons).toEqual(['Large transfer amount.', AML_HOLD_REASON]);
    expect(addHoldReason(addHoldReason({ complianceStatus: 'cleared', complianceReasons: [] })).complianceReasons)
      .toEqual([AML_HOLD_REASON]);
  });

  it('blocked -> the SAME object', () => {
    const blocked = { complianceStatus: 'blocked' as const, complianceReasons: ['Recipient matched watchlist.'] };
    expect(addHoldReason(blocked)).toBe(blocked);
  });

  it('pure: the input object and its reasons array are not mutated', () => {
    const reasons = Object.freeze(['Large transfer amount.']) as unknown as string[];
    const v = Object.freeze({ complianceStatus: 'flagged' as const, complianceReasons: reasons });
    const out = addHoldReason(v);
    expect(out).not.toBe(v);
    expect(v.complianceReasons).toEqual(['Large transfer amount.']);
    expect(out.complianceReasons).toEqual(['Large transfer amount.', AML_HOLD_REASON]);
  });

  it('extra fields of the verdict are kept', () => {
    const v = { complianceStatus: 'cleared' as const, complianceReasons: [] as string[], extra: 42 };
    expect(addHoldReason(v)).toEqual({ complianceStatus: 'flagged', complianceReasons: [AML_HOLD_REASON], extra: 42 });
  });
});

// Fix pack 6 T19 (P13, P17): the partner writer's next corridor entry, the "no entry" test the
// go-live default keys on, and the admin compliance page's resolved-rule label.
describe('hasAmlHoldEntry (P13 "no entry")', () => {
  it('neither key stored -> false; either key stored (any value) -> true', () => {
    expect(hasAmlHoldEntry(undefined)).toBe(false);
    expect(hasAmlHoldEntry({})).toBe(false);
    expect(hasAmlHoldEntry({ largeAmountUsd: 5000, watchlistExtra: ['x'] })).toBe(false);
    expect(hasAmlHoldEntry({ amlHolds: true })).toBe(true);
    expect(hasAmlHoldEntry({ amlHolds: false })).toBe(true);
    expect(hasAmlHoldEntry({ amlHoldRules: [] })).toBe(true);
    expect(hasAmlHoldEntry({ amlHoldRules: ['structuring'] })).toBe(true);
  });
});

describe('amlHoldRulesEntry (P17)', () => {
  it('non-empty -> amlHolds true + the list; other keys kept; the input is not mutated', () => {
    const prev = { largeAmountUsd: 5000, watchlistExtra: ['x y'], amlHoldRules: ['bogus'] };
    const copy = JSON.parse(JSON.stringify(prev));
    expect(amlHoldRulesEntry(prev, ['structuring', 'new_beneficiary'])).toEqual({
      largeAmountUsd: 5000, watchlistExtra: ['x y'], amlHolds: true, amlHoldRules: ['structuring', 'new_beneficiary'],
    });
    expect(prev).toEqual(copy);
  });
  it('empty -> amlHolds DELETED (never false) and [] stored; resolves to holds off', () => {
    const e = amlHoldRulesEntry({ amlHolds: true, amlHoldRules: ['structuring'], velocityLimit: 9 }, []);
    expect(e).toEqual({ velocityLimit: 9, amlHoldRules: [] });
    expect(Object.hasOwn(e, 'amlHolds')).toBe(false);
    expect(hasAmlHoldEntry(e)).toBe(true);
    expect(resolveAmlHoldRules(e.amlHolds === true, e.amlHoldRules)).toEqual([]);
  });
  it('no previous entry', () => {
    expect(amlHoldRulesEntry(undefined, ['first_transfer'])).toEqual({ amlHolds: true, amlHoldRules: ['first_transfer'] });
    expect(amlHoldRulesEntry(undefined, [])).toEqual({ amlHoldRules: [] });
  });
  it('the stored list is a fresh plain array (never the caller\'s or a frozen one)', () => {
    const e = amlHoldRulesEntry(undefined, AML_HOLD_RULES);
    expect(e.amlHoldRules).toEqual([...AML_HOLD_RULES]);
    expect(e.amlHoldRules).not.toBe(AML_HOLD_RULES);
    expect(Object.isFrozen(e.amlHoldRules)).toBe(false);
  });
});

describe('amlHoldRulesSummary (admin compliance page, P13)', () => {
  it('the resolved rule list as inline staff English', () => {
    expect(amlHoldRulesSummary(false, [])).toBe('Off');
    expect(amlHoldRulesSummary(false, AML_HOLD_RULES)).toBe('Off');
    expect(amlHoldRulesSummary(true, AML_HOLD_RULES)).toBe('On: all rules');
    expect(amlHoldRulesSummary(true, ['structuring', 'first_transfer'])).toBe('On: structuring, first transfer');
    expect(amlHoldRulesSummary(true, ['new_beneficiary'])).toBe('On: new beneficiary');
    expect(amlHoldRulesSummary(true, [])).toBe('On: no rules');
  });
});
