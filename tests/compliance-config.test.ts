import { describe, it, expect } from 'vitest';
import {
  resolveCorridorRules,
  GLOBAL_DEFAULTS,
  CORRIDOR_DEFAULTS,
} from '@/lib/compliance-config';
import { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from '@/lib/compliance';
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
