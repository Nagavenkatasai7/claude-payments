import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import {
  RISK_SIGNALS,
  RISK_SIGNALS_OFF,
  evaluateRiskSignals,
  isRiskSignal,
  riskAckMissing,
  riskSignalsApply,
  type RiskSignalConfig,
  type RiskSignalFacts,
} from '@/lib/risk-signals';

// Fix pack 6 T21 (R48, P18) — the pure, client-safe risk-signal rules. Off by
// default; never for the default tenant, sandbox ('test') rows or b2b. Dates
// are relative to now (CLAUDE.md "Test fixtures").

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const on: RiskSignalConfig = { ...RISK_SIGNALS_OFF, enabled: true };

/** Facts that fire nothing under `on`. */
function quiet(o: Partial<RiskSignalFacts> = {}): RiskSignalFacts {
  return {
    amountUsd: 100,
    sends: { total: 3, toRecipient: 2 },
    firstSeenAt: hoursAgo(1000),
    now,
    chatCue: false,
    ...o,
  };
}

describe('the risk signal enum', () => {
  it('RISK_SIGNALS equals the five names in order and is frozen', () => {
    expect([...RISK_SIGNALS]).toEqual([
      'first_to_recipient', 'first_transfer', 'new_account', 'amount_over_threshold', 'chat_cue',
    ]);
    expect(Object.isFrozen(RISK_SIGNALS)).toBe(true);
  });

  it('isRiskSignal accepts each name and nothing else', () => {
    for (const s of RISK_SIGNALS) expect(isRiskSignal(s)).toBe(true);
    for (const v of ['FIRST_TRANSFER', '', null, 'cluster', undefined, 1, {}]) expect(isRiskSignal(v)).toBe(false);
  });
});

describe('RISK_SIGNALS_OFF', () => {
  it('is frozen, { enabled: false, amountUsd: 500, newAccountHours: 72, hold: [] }, hold frozen too', () => {
    expect(RISK_SIGNALS_OFF).toEqual({ enabled: false, amountUsd: 500, newAccountHours: 72, hold: [] });
    expect(Object.isFrozen(RISK_SIGNALS_OFF)).toBe(true);
    expect(Object.isFrozen(RISK_SIGNALS_OFF.hold)).toBe(true);
  });
});

describe('riskSignalsApply', () => {
  it('is true for an enabled config on a partner, live b2c, and with environment/transferType absent', () => {
    expect(riskSignalsApply({ cfg: on, partnerId: 'acme', environment: 'live', transferType: 'b2c' })).toBe(true);
    expect(riskSignalsApply({ cfg: on, partnerId: 'acme' })).toBe(true);
  });

  it('is false when disabled, for the default tenant, for test rows and for b2b', () => {
    expect(riskSignalsApply({ cfg: RISK_SIGNALS_OFF, partnerId: 'acme', environment: 'live', transferType: 'b2c' })).toBe(false);
    expect(riskSignalsApply({ cfg: on, partnerId: DEFAULT_PARTNER_ID })).toBe(false);
    expect(riskSignalsApply({ cfg: on, partnerId: 'acme', environment: 'test' })).toBe(false);
    expect(riskSignalsApply({ cfg: on, partnerId: 'acme', transferType: 'b2b' })).toBe(false);
  });
});

describe('evaluateRiskSignals', () => {
  it('returns [] when the config is off, whatever the facts', () => {
    const loud = quiet({ amountUsd: 10_000, sends: { total: 0, toRecipient: 0 }, firstSeenAt: hoursAgo(1), chatCue: true });
    expect(evaluateRiskSignals(loud, RISK_SIGNALS_OFF)).toEqual([]);
    expect(evaluateRiskSignals(loud, { ...on, enabled: false })).toEqual([]);
  });

  it('quiet facts fire nothing', () => {
    expect(evaluateRiskSignals(quiet(), on)).toEqual([]);
  });

  it('first_to_recipient: toRecipient 0 fires; 1 does not; null (no recipient phone) does not', () => {
    expect(evaluateRiskSignals(quiet({ sends: { total: 3, toRecipient: 0 } }), on)).toEqual(['first_to_recipient']);
    expect(evaluateRiskSignals(quiet({ sends: { total: 3, toRecipient: 1 } }), on)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ sends: { total: 3, toRecipient: null } }), on)).toEqual([]);
  });

  it('first_transfer: total 0 fires; 1 does not; sends null (read failed) gives neither sends signal', () => {
    expect(evaluateRiskSignals(quiet({ sends: { total: 0, toRecipient: null } }), on)).toEqual(['first_transfer']);
    expect(evaluateRiskSignals(quiet({ sends: { total: 1, toRecipient: 1 } }), on)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ sends: null }), on)).toEqual([]);
  });

  it('a first-ever send to a new recipient gives both first_to_recipient and first_transfer', () => {
    expect(evaluateRiskSignals(quiet({ sends: { total: 0, toRecipient: 0 } }), on)).toEqual([
      'first_to_recipient', 'first_transfer',
    ]);
  });

  it('new_account: strictly younger than newAccountHours fires; older, exact, null and unparsable do not; future fires', () => {
    expect(evaluateRiskSignals(quiet({ firstSeenAt: hoursAgo(2) }), on)).toEqual(['new_account']);
    expect(evaluateRiskSignals(quiet({ firstSeenAt: hoursAgo(100) }), on)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ firstSeenAt: hoursAgo(72) }), on)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ firstSeenAt: null }), on)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ firstSeenAt: 'not-a-date' }), on)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ firstSeenAt: hoursAgo(-5) }), on)).toEqual(['new_account']);
  });

  it('new_account respects a custom newAccountHours', () => {
    expect(evaluateRiskSignals(quiet({ firstSeenAt: hoursAgo(100) }), { ...on, newAccountHours: 200 })).toEqual(['new_account']);
  });

  it('amount_over_threshold: equal fires (>=); one cent below does not; respects a custom amountUsd', () => {
    expect(evaluateRiskSignals(quiet({ amountUsd: 500 }), on)).toEqual(['amount_over_threshold']);
    expect(evaluateRiskSignals(quiet({ amountUsd: 499.99 }), on)).toEqual([]);
    const high = { ...on, amountUsd: 1000 };
    expect(evaluateRiskSignals(quiet({ amountUsd: 999.99 }), high)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ amountUsd: 1000 }), high)).toEqual(['amount_over_threshold']);
  });

  it('chat_cue fires only from facts.chatCue === true', () => {
    expect(evaluateRiskSignals(quiet({ chatCue: true }), on)).toEqual(['chat_cue']);
    expect(evaluateRiskSignals(quiet({ chatCue: 'true' as unknown as boolean }), on)).toEqual([]);
    expect(evaluateRiskSignals(quiet({ chatCue: 1 as unknown as boolean }), on)).toEqual([]);
  });

  it('the result is in enum order and has no duplicates', () => {
    const all = evaluateRiskSignals(
      quiet({ amountUsd: 5000, sends: { total: 0, toRecipient: 0 }, firstSeenAt: hoursAgo(1), chatCue: true }),
      on,
    );
    expect(all).toEqual([...RISK_SIGNALS]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('never mutates the shared OFF config', () => {
    evaluateRiskSignals(quiet(), on);
    expect(RISK_SIGNALS_OFF).toEqual({ enabled: false, amountUsd: 500, newAccountHours: 72, hold: [] });
  });
});

describe('riskAckMissing', () => {
  it('needs a literal true tick only when a warning was shown', () => {
    expect(riskAckMissing([], false)).toBe(false);
    expect(riskAckMissing([], undefined)).toBe(false);
    expect(riskAckMissing(['first_transfer'], false)).toBe(true);
    expect(riskAckMissing(['first_transfer'], true)).toBe(false);
    expect(riskAckMissing(['first_transfer'], 'true')).toBe(true);
    expect(riskAckMissing(['first_transfer'], 1)).toBe(true);
    expect(riskAckMissing(['first_transfer'], undefined)).toBe(true);
  });
});

describe('risk-signals.ts stays client-safe (P0 rule 13)', () => {
  it('the module has no runtime import except ./defaults', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/risk-signals.ts'), 'utf8');
    // Whole import statements, multi-line ones included.
    const imports = src.match(/^\s*import\b[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const stmt of imports) {
      const s = stmt.trim();
      const ok = s.startsWith('import type ') || /^import\s*\{\s*DEFAULT_PARTNER_ID\s*\}\s*from\s*'\.\/defaults';?$/.test(s);
      expect(ok, `runtime import in src/lib/risk-signals.ts: ${s}`).toBe(true);
    }
    expect(src).not.toMatch(/^\s*import\s+['"]/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/^\s*export\s[^;]*\sfrom\s/m);
  });
});
