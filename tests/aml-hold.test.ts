import { describe, it, expect } from 'vitest';
import {
  AML_HOLD_REASON,
  amlHoldGate,
  amlHoldRailEligible,
  amlHoldHit,
  applyAmlHold,
} from '@/lib/aml-hold';
import { AML_DEFAULTS, type SenderAmlStats } from '@/lib/aml-rules';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

// Program-Fix 43 PR B: the optional per-partner AML hold, as PURE decisions.
// Owner decision (binding): AML rules raise alerts only; a hard hold comes
// ONLY from a per-partner setting that is OFF by default, and a demo transfer
// (the default tenant, or any non-http rail) is NEVER held.

const cfg = { ...AML_DEFAULTS, largeAmountUsd: 1000 };
const none: SenderAmlStats = { bandCount7d: 0, subTSumCents30d: 0, subTCount30d: 0, priorCount: 0 };
const seasoned: SenderAmlStats = { bandCount7d: 0, subTSumCents30d: 0, subTCount30d: 5, priorCount: 5 };

describe('amlHoldGate (the pre-read gate: false ⇒ zero AML statements)', { retry: 0 }, () => {
  const on = { amlHolds: true, partnerId: 'acme', railPartnerId: 'acme', complianceStatus: 'cleared' as const };

  it('setting ON, a non-default tenant, a cleared verdict ⇒ run the check', () => {
    expect(amlHoldGate(on)).toBe(true);
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

  it('never downgrades: a flagged or blocked verdict is left alone (no read either)', () => {
    expect(amlHoldGate({ ...on, complianceStatus: 'flagged' })).toBe(false);
    expect(amlHoldGate({ ...on, complianceStatus: 'blocked' })).toBe(false);
  });

  it('only a literal true switches it on', () => {
    expect(amlHoldGate({ ...on, amlHolds: 'true' as unknown as boolean })).toBe(false);
    expect(amlHoldGate({ ...on, amlHolds: 1 as unknown as boolean })).toBe(false);
  });
});

describe('amlHoldRailEligible (demo = any non-http rail)', { retry: 0 }, () => {
  it('only a real http rail can hold', () => {
    expect(amlHoldRailEligible('http')).toBe(true);
    for (const t of ['simulator', 'mock', '', 'HTTP', null, undefined]) {
      expect(amlHoldRailEligible(t)).toBe(false);
    }
  });
});

describe('amlHoldHit (R1 structuring + R2 first transfer; R2b/R3 are sweep-only)', { retry: 0 }, () => {
  it('a large first-ever transfer is a hit', () => {
    expect(amlHoldHit(none, 600, cfg)?.rule).toBe('first_transfer');
  });

  it('a small first-ever transfer is not', () => {
    expect(amlHoldHit(none, 200, cfg)).toBeNull();
  });

  it('the send that completes a structuring run is a hit', () => {
    expect(amlHoldHit({ ...seasoned, bandCount7d: 2 }, 900, cfg)?.rule).toBe('structuring');
  });

  it('an ordinary repeat send is not', () => {
    expect(amlHoldHit(seasoned, 900, cfg)).toBeNull();
  });

  it('a new-beneficiary verdict is never taken in the mint (the destination history lives in the sweep)', () => {
    expect(amlHoldHit(seasoned, 900, cfg)).toBeNull();
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

  it('a flagged or blocked verdict is never touched, hit or not', () => {
    const flagged = { complianceStatus: 'flagged' as const, complianceReasons: ['Large transfer amount.'] };
    const blocked = { complianceStatus: 'blocked' as const, complianceReasons: ['Recipient matched watchlist.'] };
    expect(applyAmlHold(flagged, hit)).toBe(flagged);
    expect(applyAmlHold(blocked, hit)).toBe(blocked);
  });
});
