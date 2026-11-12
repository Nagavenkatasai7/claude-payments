import { describe, it, expect } from 'vitest';
import {
  resolveCorridorRules,
  GLOBAL_DEFAULTS,
  CORRIDOR_DEFAULTS,
  resolveAmlHoldRules,
} from '@/lib/compliance-config';
import { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from '@/lib/compliance';
import { RISK_SIGNALS_OFF } from '@/lib/risk-signals';
import type { Partner } from '@/lib/types';

function partner(corridorCompliance?: Partner['corridorCompliance']): Partner {
  return {
    id: 'p', name: 'P', countries: ['US'], status: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    corridorCompliance,
  };
}

describe('GLOBAL_DEFAULTS (dormancy anchor)', () => {
  it('re-exports today\'s literal globals', () => {
    expect(GLOBAL_DEFAULTS.baseWatchlist).toBe(WATCHLIST);
    expect(GLOBAL_DEFAULTS.largeAmountUsd).toBe(LARGE_AMOUNT_USD); // 1000
    expect(GLOBAL_DEFAULTS.velocityLimit).toBe(VELOCITY_LIMIT);    // 3
    expect(GLOBAL_DEFAULTS.watchlistExtra).toEqual([]);
  });
  it('ships CORRIDOR_DEFAULTS empty (everything inherits globals)', () => {
    expect(CORRIDOR_DEFAULTS).toEqual({});
  });
});

describe('resolveCorridorRules — dormant path', () => {
  it('null partner + US → GLOBAL_DEFAULTS', () => {
    expect(resolveCorridorRules(null, 'US')).toEqual(GLOBAL_DEFAULTS);
  });
  it('default-shaped partner (no corridorCompliance) + US → GLOBAL_DEFAULTS', () => {
    expect(resolveCorridorRules(partner(), 'US')).toEqual(GLOBAL_DEFAULTS);
  });
  it('undefined corridorCompliance for a configured-elsewhere partner still → globals for that corridor', () => {
    expect(resolveCorridorRules(partner({ GB: { velocityLimit: 9 } }), 'US')).toEqual(GLOBAL_DEFAULTS);
  });
});

describe('resolveCorridorRules — override merge', () => {
  it('override replaces a single numeric field, inherits the rest', () => {
    const r = resolveCorridorRules(partner({ GB: { largeAmountUsd: 5000 } }), 'GB');
    expect(r.largeAmountUsd).toBe(5000);
    expect(r.velocityLimit).toBe(VELOCITY_LIMIT); // inherited
    expect(r.baseWatchlist).toBe(WATCHLIST);      // inherited
  });
  it('watchlistExtra is concatenated, not replaced', () => {
    const r = resolveCorridorRules(partner({ GB: { watchlistExtra: ['corridor villain'] } }), 'GB');
    expect(r.watchlistExtra).toEqual(['corridor villain']);
    expect(r.baseWatchlist).toBe(WATCHLIST); // base intact
  });
  it('honors a numeric 0 override (uses ?? not ||)', () => {
    const r = resolveCorridorRules(partner({ GB: { velocityLimit: 0 } }), 'GB');
    expect(r.velocityLimit).toBe(0);
  });
  it('ignores an IN (payout-side) key', () => {
    const r = resolveCorridorRules(partner({ IN: { velocityLimit: 1 } }), 'IN');
    expect(r).toEqual(GLOBAL_DEFAULTS);
  });
  it('carries kycCapHintUsd through (advisory only)', () => {
    const r = resolveCorridorRules(partner({ GB: { kycCapHintUsd: 3000 } }), 'GB');
    expect(r.kycCapHintUsd).toBe(3000);
  });
});

// Program-Fix 43: the behavioural AML thresholds + the (PR B) hold switch
// live INSIDE GLOBAL_DEFAULTS, so the dormant toEqual(GLOBAL_DEFAULTS) pins
// above stay green; a corridor override merges field by field and untrusted
// jsonb values fall back to the default.
describe('resolveCorridorRules — AML (Program-Fix 43)', () => {
  it('GLOBAL_DEFAULTS carries the AML defaults and amlHolds OFF', () => {
    expect(GLOBAL_DEFAULTS.aml).toEqual({ band: 0.8, count: 3, aggUsd: 3000, firstUsd: 500, senders: 3 });
    expect(GLOBAL_DEFAULTS.amlHolds).toBe(false);
  });
  it('fast path still returns the shared GLOBAL_DEFAULTS object', () => {
    expect(resolveCorridorRules(null, 'US')).toBe(GLOBAL_DEFAULTS);
  });
  it('a corridor override without aml keeps the default aml + amlHolds false', () => {
    const r = resolveCorridorRules(partner({ GB: { largeAmountUsd: 5000 } }), 'GB');
    expect(r.aml).toEqual(GLOBAL_DEFAULTS.aml);
    expect(r.amlHolds).toBe(false);
  });
  it('aml overrides merge per field', () => {
    const r = resolveCorridorRules(partner({ GB: { aml: { count: 5, firstUsd: 250 } } }), 'GB');
    expect(r.aml).toEqual({ band: 0.8, count: 5, aggUsd: 3000, firstUsd: 250, senders: 3 });
  });
  it('untrusted aml values (non-number, negative, non-finite, band outside (0,1]) fall back to defaults', () => {
    const bad = { band: 7, count: -1, aggUsd: 'lots', firstUsd: Number.POSITIVE_INFINITY, senders: null } as unknown;
    const r = resolveCorridorRules(partner({ GB: { aml: bad as never } }), 'GB');
    expect(r.aml).toEqual(GLOBAL_DEFAULTS.aml);
  });
  it('amlHolds is true only for a literal true', () => {
    expect(resolveCorridorRules(partner({ GB: { amlHolds: true } }), 'GB').amlHolds).toBe(true);
    expect(resolveCorridorRules(partner({ GB: { amlHolds: 'yes' as never } }), 'GB').amlHolds).toBe(false);
  });
});

// Pack 2 review R3 (H1 display truth): the one label every staff view and the
// advisory KYC prompt use, so a stamped, uncleared hold never reads "clear".
describe('senderScreeningLabel (pack 2 review R3)', () => {
  it('names a hit, a stamped hold with no boolean, and clear by the shared rule', async () => {
    const { senderScreeningLabel } = await import('@/lib/compliance-config');
    const t0 = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const t1 = new Date(Date.now() - 3_600_000).toISOString();
    expect(senderScreeningLabel({ watchlistHit: true, pepHit: true })).toBe('watchlist');
    expect(senderScreeningLabel({ pepHit: true })).toBe('pep');
    // A stale upsert nulled the booleans; the stamp keeps the hold.
    expect(senderScreeningLabel({ watchlistHit: null, pepHit: null, screeningFlaggedAt: t0 })).toBe('hold');
    expect(senderScreeningLabel({ screeningFlaggedAt: t0, screeningClearedAt: t1 })).toBe('clear');
    expect(senderScreeningLabel({ screeningFlaggedAt: t1, screeningClearedAt: t0 })).toBe('hold');
    expect(senderScreeningLabel({})).toBe('clear');
  });
});

// Fix pack 6 (P13): per corridor, WHICH in-mint AML rules hold when amlHolds
// is on. The stored list is untrusted jsonb; the resolved one is a closed,
// canonical, frozen list (empty unless amlHolds is literally true).
describe('resolveCorridorRules - amlHoldRules (pack 6 P13)', () => {
  const ALL = ['structuring', 'first_transfer', 'new_beneficiary'];
  const rulesOf = (entry: unknown) =>
    resolveCorridorRules(partner({ GB: entry as never }), 'GB').amlHoldRules;

  it('GLOBAL_DEFAULTS.amlHoldRules is [] and frozen', () => {
    expect(GLOBAL_DEFAULTS.amlHoldRules).toEqual([]);
    expect(Object.isFrozen(GLOBAL_DEFAULTS.amlHoldRules)).toBe(true);
  });
  it('fast path still returns the shared GLOBAL_DEFAULTS object', () => {
    expect(resolveCorridorRules(null, 'US')).toBe(GLOBAL_DEFAULTS);
    expect(resolveCorridorRules(partner({ GB: { amlHolds: true } }), 'US')).toBe(GLOBAL_DEFAULTS);
    expect(resolveCorridorRules(partner({ IN: { amlHolds: true, amlHoldRules: ['structuring'] } }), 'IN')).toBe(GLOBAL_DEFAULTS);
  });
  it("amlHolds true, no amlHoldRules stored -> ['structuring', 'first_transfer', 'new_beneficiary']", () => {
    expect(rulesOf({ amlHolds: true })).toEqual(ALL);
  });
  it("amlHolds true + ['new_beneficiary', 'structuring', 'structuring'] -> ['structuring', 'new_beneficiary']", () => {
    expect(rulesOf({ amlHolds: true, amlHoldRules: ['new_beneficiary', 'structuring', 'structuring'] }))
      .toEqual(['structuring', 'new_beneficiary']);
  });
  it("amlHolds true + ['cluster', 'bogus', 7, null] -> []; amlHolds true + [] -> []", () => {
    expect(rulesOf({ amlHolds: true, amlHoldRules: ['cluster', 'bogus', 7, null] })).toEqual([]);
    expect(rulesOf({ amlHolds: true, amlHoldRules: [] })).toEqual([]);
  });
  it("amlHolds true + a non-array value ('structuring', {}, 5) -> all three", () => {
    for (const bad of ['structuring', {}, 5]) {
      expect(rulesOf({ amlHolds: true, amlHoldRules: bad })).toEqual(ALL);
    }
  });
  it('amlHolds absent or false + any stored list -> []', () => {
    expect(rulesOf({ amlHoldRules: ['structuring'] })).toEqual([]);
    expect(rulesOf({ amlHolds: false, amlHoldRules: ALL })).toEqual([]);
    expect(rulesOf({ amlHolds: false })).toEqual([]);
  });
  it("amlHolds 'true' (string) + a list -> [] (only a literal true switches holds on)", () => {
    expect(rulesOf({ amlHolds: 'true', amlHoldRules: ['structuring'] })).toEqual([]);
  });
  it('the resolved array is a fresh, frozen array, never the stored jsonb array', () => {
    const stored = ['first_transfer'];
    const r = rulesOf({ amlHolds: true, amlHoldRules: stored });
    expect(r).not.toBe(stored);
    expect(Object.isFrozen(r)).toBe(true);
    stored.push('structuring');
    expect(r).toEqual(['first_transfer']);
    const all = rulesOf({ amlHolds: true });
    expect(Object.isFrozen(all)).toBe(true);
  });
  it('other fields are unchanged by the new key', () => {
    const r = resolveCorridorRules(partner({ GB: { amlHoldRules: ['structuring'] } }), 'GB');
    expect(r.amlHolds).toBe(false);
    expect(r.amlHoldRules).toEqual([]);
    expect(r.aml).toEqual(GLOBAL_DEFAULTS.aml);
    expect(r.largeAmountUsd).toBe(GLOBAL_DEFAULTS.largeAmountUsd);
    expect(r.velocityLimit).toBe(GLOBAL_DEFAULTS.velocityLimit);
    expect(r.watchlistExtra).toEqual([]);
  });
  it('resolveAmlHoldRules is exported with the same rules', () => {
    expect(resolveAmlHoldRules(false, ALL)).toBe(GLOBAL_DEFAULTS.amlHoldRules);
    expect(resolveAmlHoldRules(true, undefined)).toEqual(ALL);
    expect(resolveAmlHoldRules(true, 'x')).toEqual(ALL);
    expect(resolveAmlHoldRules(true, ['new_beneficiary', 'first_transfer'])).toEqual(['first_transfer', 'new_beneficiary']);
  });
});

describe('resolveCorridorRules - riskSignals (pack 6 P18)', () => {
  const sigOf = (riskSignals: unknown, extra: Record<string, unknown> = {}) =>
    resolveCorridorRules(partner({ GB: { ...extra, riskSignals } as never }), 'GB').riskSignals;

  it('GLOBAL_DEFAULTS.riskSignals is RISK_SIGNALS_OFF (the same object)', () => {
    expect(GLOBAL_DEFAULTS.riskSignals).toBe(RISK_SIGNALS_OFF);
  });
  it('fast path still returns the shared GLOBAL_DEFAULTS object', () => {
    expect(resolveCorridorRules(null, 'US')).toBe(GLOBAL_DEFAULTS);
    expect(resolveCorridorRules(partner({ GB: { riskSignals: { enabled: true } } }), 'US')).toBe(GLOBAL_DEFAULTS);
    expect(resolveCorridorRules(partner({ IN: { riskSignals: { enabled: true } } }), 'IN')).toBe(GLOBAL_DEFAULTS);
  });
  it('a corridor override without riskSignals resolves to the shared RISK_SIGNALS_OFF', () => {
    const r = resolveCorridorRules(partner({ GB: { largeAmountUsd: 2000, amlHolds: true } }), 'GB');
    expect(r).not.toBe(GLOBAL_DEFAULTS);
    expect(r.riskSignals).toBe(RISK_SIGNALS_OFF);
  });
  it('{ enabled: true } alone -> enabled with amountUsd 500, newAccountHours 72, hold []', () => {
    expect(sigOf({ enabled: true })).toEqual({ enabled: true, amountUsd: 500, newAccountHours: 72, hold: [] });
  });
  it("full valid -> { enabled: true, amountUsd: 750, newAccountHours: 24, hold: ['first_to_recipient','chat_cue'] }", () => {
    expect(sigOf({ enabled: true, amountUsd: 750, newAccountHours: 24, hold: ['chat_cue', 'first_to_recipient', 'chat_cue'] }))
      .toEqual({ enabled: true, amountUsd: 750, newAccountHours: 24, hold: ['first_to_recipient', 'chat_cue'] });
  });
  it('enabled only for a literal true', () => {
    for (const v of ['true', 1, 'yes', null]) {
      expect(sigOf({ enabled: v }).enabled).toBe(false);
    }
  });
  it('untrusted numbers fall back', () => {
    for (const v of [0, -5, NaN, Infinity, '500']) {
      expect(sigOf({ enabled: true, amountUsd: v }).amountUsd).toBe(500);
    }
    for (const v of [1.5, 0, -1, '72']) {
      expect(sigOf({ enabled: true, newAccountHours: v }).newAccountHours).toBe(72);
    }
  });
  it('untrusted hold: unknown names, non-strings, a non-array value -> filtered / []; never throws', () => {
    expect(sigOf({ enabled: true, hold: ['bogus', 7, null, {}, 'new_account', 'FIRST_TRANSFER'] }).hold).toEqual(['new_account']);
    for (const bad of ['chat_cue', { chat_cue: true }, 5, null]) {
      expect(sigOf({ enabled: true, hold: bad }).hold).toEqual([]);
    }
  });
  it("a non-object riskSignals ('on', 5, [], null) -> RISK_SIGNALS_OFF", () => {
    for (const bad of ['on', 5, [], null, true]) {
      expect(sigOf(bad)).toBe(RISK_SIGNALS_OFF);
    }
  });
  it('enabled false keeps the stored, valid thresholds', () => {
    expect(sigOf({ enabled: false, amountUsd: 1200, newAccountHours: 48, hold: ['first_transfer'] }))
      .toEqual({ enabled: false, amountUsd: 1200, newAccountHours: 48, hold: ['first_transfer'] });
  });
  it('the resolved config and its hold array are frozen and never the stored jsonb array', () => {
    const hold = ['new_account'];
    const r = sigOf({ enabled: true, hold });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.hold)).toBe(true);
    expect(r.hold).not.toBe(hold);
    hold.push('chat_cue');
    expect(r.hold).toEqual(['new_account']);
  });
  it('riskSignals does not change any other resolved field', () => {
    const base = { amlHolds: true, amlHoldRules: ['structuring'], largeAmountUsd: 1500, aml: { count: 5 } };
    const without = resolveCorridorRules(partner({ GB: base }), 'GB');
    const withKey = resolveCorridorRules(partner({ GB: { ...base, riskSignals: { enabled: true, amountUsd: 100, hold: ['chat_cue'] } } }), 'GB');
    const { riskSignals: a, ...restWithout } = without;
    const { riskSignals: b, ...restWith } = withKey;
    expect(restWith).toEqual(restWithout);
    expect(a).toBe(RISK_SIGNALS_OFF);
    expect(b.enabled).toBe(true);
    expect(withKey.aml).toEqual(without.aml);
    expect(withKey.amlHolds).toBe(true);
    expect(withKey.amlHoldRules).toEqual(['structuring']);
    expect(withKey.largeAmountUsd).toBe(1500);
  });
});
