import type { CountryCode, Partner } from './types';
import { AML_DEFAULTS, type AmlConfig } from './aml-rules';

// Canonical screening constants — single source of truth.
// compliance.ts re-exports these for backward compatibility.
// Mock sanctions/watchlist — clearly fake names for the prototype.
export const WATCHLIST = ['john doe', 'jane roe', 'test blocked'];
// Compliance review thresholds — tunable here without touching screening logic.
// LARGE_AMOUNT_USD: flag transfers >= $1000 USD-equivalent.
// VELOCITY_LIMIT: flag when sender has already sent >= this many times today.
export const LARGE_AMOUNT_USD = 1000;
export const VELOCITY_LIMIT = 5; // raised from 3: 1-4 sends/day are normal behaviour

export interface ResolvedCorridorRules {
  baseWatchlist: string[];     // the screener's base list (today's WATCHLIST)
  watchlistExtra: string[];    // corridor-specific additions (possibly empty)
  largeAmountUsd: number;      // USD-equivalent flag threshold
  velocityLimit: number;       // transfers/day before flagging
  kycCapHintUsd?: number;      // ADVISORY ONLY — consumed by the NEXT (KYC) batch
  // Program-Fix 43: behavioural AML thresholds (alerts — aml-sweep.ts) and the
  // PR B per-partner×corridor hold switch (OFF by default; read by mintLocked
  // through aml-hold.ts amlHoldGate, which never holds a demo transfer).
  aml: AmlConfig;
  amlHolds: boolean;
}

// Today's globals, named so the dormant path is PROVABLY equal to current
// behavior. baseWatchlist/largeAmountUsd/velocityLimit ARE the literal
// screening constants above — do not fork their values here.
export const GLOBAL_DEFAULTS: ResolvedCorridorRules = {
  baseWatchlist: WATCHLIST,
  watchlistExtra: [],
  largeAmountUsd: LARGE_AMOUNT_USD,   // 1000
  velocityLimit: VELOCITY_LIMIT,      // 3
  aml: AML_DEFAULTS,
  amlHolds: false,
};

// corridor_compliance is untrusted jsonb: every AML field is validated and
// falls back to the default (a bad value can never disable a rule by NaN or
// make it fire on everything by a negative).
function posNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
function posInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : fallback;
}
function resolveAml(...layers: Array<Partial<AmlConfig> | undefined>): AmlConfig {
  const pick = <K extends keyof AmlConfig>(k: K): unknown => {
    for (const l of layers) {
      const v = l && typeof l === 'object' ? (l as Record<string, unknown>)[k] : undefined;
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const band = pick('band');
  return {
    band: typeof band === 'number' && Number.isFinite(band) && band > 0 && band <= 1 ? band : AML_DEFAULTS.band,
    count: posInt(pick('count'), AML_DEFAULTS.count),
    aggUsd: posNumber(pick('aggUsd'), AML_DEFAULTS.aggUsd),
    firstUsd: posNumber(pick('firstUsd'), AML_DEFAULTS.firstUsd),
    senders: posInt(pick('senders'), AML_DEFAULTS.senders),
  };
}

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
    aml: resolveAml(override.aml, corridorDefault.aml),
    // Only a literal true switches holds on (PR B); anything else is OFF.
    amlHolds: (override.amlHolds ?? corridorDefault.amlHolds) === true,
  };
}
