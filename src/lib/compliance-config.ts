import type { CountryCode, Partner } from './types';
import { WATCHLIST, LARGE_AMOUNT_USD, VELOCITY_LIMIT } from './compliance';

export interface ResolvedCorridorRules {
  baseWatchlist: string[];     // the screener's base list (today's WATCHLIST)
  watchlistExtra: string[];    // corridor-specific additions (possibly empty)
  largeAmountUsd: number;      // USD-equivalent flag threshold
  velocityLimit: number;       // transfers/day before flagging
  kycCapHintUsd?: number;      // ADVISORY ONLY — consumed by the NEXT (KYC) batch
}

// Today's globals, named so the dormant path is PROVABLY equal to current
// behavior. baseWatchlist/largeAmountUsd/velocityLimit ARE the literal
// compliance.ts constants — do not fork their values here.
export const GLOBAL_DEFAULTS: ResolvedCorridorRules = {
  baseWatchlist: WATCHLIST,
  watchlistExtra: [],
  largeAmountUsd: LARGE_AMOUNT_USD,   // 1000
  velocityLimit: VELOCITY_LIMIT,      // 3
};

// Code-defined per-corridor DEFAULTS. EMPTY at ship time — every corridor
// inherits GLOBAL_DEFAULTS. Populated later as real corridors are calibrated
// (partner-interest-driven, like P4's deferred per-currency cap/fee tables).
// US is intentionally absent → falls through to GLOBAL_DEFAULTS → byte-for-byte.
export const CORRIDOR_DEFAULTS: Partial<Record<CountryCode, Partial<ResolvedCorridorRules>>> = {};

export function resolveCorridorRules(
  partner: Partner | null,
  sourceCountry: CountryCode,
): ResolvedCorridorRules {
  // IN is the payout side; it is never a corridor source. Ignore it.
  if (sourceCountry === 'IN') return GLOBAL_DEFAULTS;

  const corridorDefault = CORRIDOR_DEFAULTS[sourceCountry] ?? {};
  const override = partner?.corridorCompliance?.[sourceCountry] ?? {};

  // Each numeric field: override ?? corridorDefault ?? GLOBAL_DEFAULTS (?? so a
  // legitimate 0 is honored). watchlistExtra is CONCATENATED, not replaced.
  const watchlistExtra = (corridorDefault.watchlistExtra ?? []).concat(override.watchlistExtra ?? []);

  // Fast path: nothing configured for this corridor → return the shared
  // GLOBAL_DEFAULTS object so the dormant equality (=== GLOBAL_DEFAULTS) holds.
  const hasCorridorDefault = CORRIDOR_DEFAULTS[sourceCountry] !== undefined;
  const hasOverride = partner?.corridorCompliance?.[sourceCountry] !== undefined;
  if (!hasCorridorDefault && !hasOverride) return GLOBAL_DEFAULTS;

  return {
    baseWatchlist: GLOBAL_DEFAULTS.baseWatchlist,
    watchlistExtra,
    largeAmountUsd: override.largeAmountUsd ?? corridorDefault.largeAmountUsd ?? GLOBAL_DEFAULTS.largeAmountUsd,
    velocityLimit: override.velocityLimit ?? corridorDefault.velocityLimit ?? GLOBAL_DEFAULTS.velocityLimit,
    kycCapHintUsd: override.kycCapHintUsd ?? corridorDefault.kycCapHintUsd,
  };
}
