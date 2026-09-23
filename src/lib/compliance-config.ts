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

// ── Screening-derived hold reasons (Program-Fix 43 follow-up) ──────────────
// The exact complianceReasons strings sanctions / name screening writes
// (screenTransfer in compliance.ts emits ONLY these constants). Generic on
// purpose: reasons reach staff views and must never name a list entry, the
// screened person, or the word "sanctions". Defined in this leaf module (no
// provider / crypto imports) so dashboard-ops can key on them cheaply;
// compliance.ts re-exports them. Changing a string here changes what new rows
// carry, so a rename must keep the old string in SCREENING_REASONS.
export const POSSIBLE_MATCH_REASON = 'Name screening needs manual review.';
export const LIST_UNAVAILABLE_REASON = 'Screening list unavailable; needs manual review.';
export const RECIPIENT_WATCHLIST_REASON = 'Recipient is on the compliance watchlist.';
export const SENDER_WATCHLIST_REASON = 'Sender is on the compliance watchlist.';
// Program-Fix 14 follow-up: a partner-API mint with no sender name cannot be
// name-screened on the sender side, so it is held for review (mintLocked, via
// CreateTransferInput.senderIdentityMissing). Screening-derived: a delegated
// partner's staff may not release it — KYC may be delegated, sanctions may not.
export const SENDER_IDENTITY_MISSING_REASON = 'Sender identity missing.';
export const SCREENING_REASONS: readonly string[] = [
  POSSIBLE_MATCH_REASON,
  LIST_UNAVAILABLE_REASON,
  RECIPIENT_WATCHLIST_REASON,
  SENDER_WATCHLIST_REASON,
  SENDER_IDENTITY_MISSING_REASON,
];

/**
 * True when ANY of the hold's reasons came from sanctions / name screening.
 * Such a hold is released by PLATFORM staff only (canReleaseHeld), whatever
 * the owning partner's KYC mode: KYC may be delegated, sanctions may not.
 * Fails CLOSED: a hold with no (or a malformed) reasons list has unknown
 * provenance and counts as a screening hold. Every path that holds a transfer
 * (screening, EDD, the optional AML hold) appends a non-empty reason.
 */
export function isScreeningHold(t: { complianceReasons?: readonly string[] | null }): boolean {
  const reasons = t.complianceReasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return true;
  return reasons.some((r) => SCREENING_REASONS.includes(r));
}

/**
 * Program-Fix 43 follow-up: a CUSTOMER-level screening hold — a Persona
 * watchlist/sanctions or PEP report matched (kyc-state-machine sets the flag).
 * Deciding such a customer (approve / reject / manual override) is
 * PLATFORM-only. Known residual: Persona "other" matches (e.g. adverse media)
 * set needs_review with no flag, so they are not distinguishable here.
 */
export function isScreeningCustomerHold(c: { watchlistHit?: boolean | null; pepHit?: boolean | null }): boolean {
  return c.watchlistHit === true || c.pepHit === true;
}

/** Who may decide a customer's KYC: platform staff always; partner staff only without a screening hit. */
export function canDecideCustomerKyc(
  scope: { kind: 'platform' | 'partner' },
  c: { watchlistHit?: boolean | null; pepHit?: boolean | null },
): boolean {
  if (scope.kind === 'platform') return true;
  return !isScreeningCustomerHold(c);
}

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
