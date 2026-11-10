import type { CountryCode, Partner } from './types';
import { AML_DEFAULTS, type AmlConfig } from './aml-rules';
import type { FixedReplyKind } from './hold-replies';

// Canonical screening constants — single source of truth.
// compliance.ts re-exports these for backward compatibility.
// Mock sanctions/watchlist — clearly fake names for the prototype.
export const WATCHLIST = ['john doe', 'jane roe', 'test blocked'];
// Compliance review thresholds — tunable here without touching screening logic.
// LARGE_AMOUNT_USD: flag transfers >= $1000 USD-equivalent.
// VELOCITY_LIMIT: flag when sender has already sent >= this many times today.
export const LARGE_AMOUNT_USD = 1000;
export const VELOCITY_LIMIT = 5; // raised from 3: 1-4 sends/day are normal behaviour

// ── Hold reasons (Program-Fix 43 follow-up; Fix pack 2 registry) ───────────
// The exact complianceReasons strings stored rows carry. Generic on purpose:
// reasons reach staff views and must never name a list entry, the screened
// person, or the word "sanctions". Defined in this leaf module (no provider /
// crypto imports) so dashboard-ops can key on them cheaply; compliance.ts
// re-exports them. Changing a string here changes what new rows carry: never
// change one (tests/hold-reason-registry and partner-releasable-hold pin them).
export const POSSIBLE_MATCH_REASON = 'Name screening needs manual review.';
export const LIST_UNAVAILABLE_REASON = 'Screening list unavailable; needs manual review.';
export const RECIPIENT_WATCHLIST_REASON = 'Recipient is on the compliance watchlist.';
export const SENDER_WATCHLIST_REASON = 'Sender is on the compliance watchlist.';
// Program-Fix 14 follow-up: a partner-API mint with no sender name cannot be
// name-screened on the sender side, so it is held for review (mintLocked, via
// CreateTransferInput.senderIdentityMissing). Screening-derived: a delegated
// partner's staff may not release it — KYC may be delegated, sanctions may not.
export const SENDER_IDENTITY_MISSING_REASON = 'Sender identity missing.';
// Fix pack 2 (R06): the SENDER's customer row carries an uncleared screening
// hit (senderScreeningHoldActive). Platform clears it with an audited action.
export const SENDER_SCREENING_REASON = 'Sender screening needs manual review.';
// Fix pack 4 (R03, C19): a real-money b2c transfer reached settlement with no
// account-holder name on file (settleOrHold). Screening-derived: its recipient
// cannot be name-screened by the name the payout bank checks. Platform staff
// only; the release is refused while the name is missing (releaseHold), so
// until PR7 such a row is rejected or refunded.
export const RECIPIENT_IDENTITY_MISSING_REASON = 'Recipient identity missing.';
// The non-screening flag reasons screenTransfer (compliance.ts) and the EDD
// check (tier-rules.ts evaluateEddForTransfer) write (UI redesign M3-10).
export const LARGE_AMOUNT_REASON = 'Large transfer amount.';
export const VELOCITY_REASON = 'High transfer velocity.';
export const EDD_REQUIRED_REASON = 'edd_required';
// Program-Fix 43 PR B: the optional per-partner AML hold (aml-hold.ts, which
// re-exports it). Deliberately generic: it never names the rule.
export const AML_HOLD_REASON = 'Additional review required.';

/**
 * Who may release a hold carrying a reason:
 *  - 'partner': a delegated partner's admin (and platform staff);
 *  - 'platform': SmartRemit platform staff only;
 *  - 'rescreen': no person — it lifts only by the automatic re-screen against
 *    a fresh sanctions list (Fix pack 2 T4).
 */
export type HoldReleasableBy = 'partner' | 'platform' | 'rescreen';

export type HoldReasonEntry = {
  class: 'screening' | 'kyc' | 'aml';
  releasableBy: HoldReleasableBy;
  /** The fixed customer wording (hold-replies.ts) for a transfer held for this reason. */
  customerCopyKey: FixedReplyKind;
};

/**
 * Fix pack 2 (R04): THE registry of every stored hold reason. A reason not in
 * it is unknown provenance and treated as platform-only (holdReleasableBy).
 * SPEC §3.3 + D7, owner answer O1 (2026-09-28): only KYC-class reasons are
 * partner-releasable; every screening reason and the AML hold stay
 * platform-only; LIST_UNAVAILABLE lifts only by the automatic re-screen.
 */
export const HOLD_REASONS: Readonly<Record<string, HoldReasonEntry>> = Object.freeze({
  [POSSIBLE_MATCH_REASON]: { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
  [LIST_UNAVAILABLE_REASON]: { class: 'screening', releasableBy: 'rescreen', customerCopyKey: 'hold' },
  [RECIPIENT_WATCHLIST_REASON]: { class: 'screening', releasableBy: 'platform', customerCopyKey: 'block' },
  [SENDER_WATCHLIST_REASON]: { class: 'screening', releasableBy: 'platform', customerCopyKey: 'block' },
  [SENDER_IDENTITY_MISSING_REASON]: { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
  [SENDER_SCREENING_REASON]: { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
  [RECIPIENT_IDENTITY_MISSING_REASON]: { class: 'screening', releasableBy: 'platform', customerCopyKey: 'hold' },
  [LARGE_AMOUNT_REASON]: { class: 'kyc', releasableBy: 'partner', customerCopyKey: 'hold' },
  [VELOCITY_REASON]: { class: 'kyc', releasableBy: 'partner', customerCopyKey: 'hold' },
  [EDD_REQUIRED_REASON]: { class: 'kyc', releasableBy: 'partner', customerCopyKey: 'hold' },
  [AML_HOLD_REASON]: { class: 'aml', releasableBy: 'platform', customerCopyKey: 'hold' },
} satisfies Record<string, HoldReasonEntry>);

function registryEntry(r: unknown): HoldReasonEntry | undefined {
  return typeof r === 'string' && Object.hasOwn(HOLD_REASONS, r) ? HOLD_REASONS[r] : undefined;
}

/** Every screening-derived reason (derived from HOLD_REASONS). */
export const SCREENING_REASONS: readonly string[] = Object.keys(HOLD_REASONS).filter(
  (r) => HOLD_REASONS[r]!.class === 'screening',
);

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
 * The ONLY hold reasons a delegated partner's admin may release from /partner
 * (derived from HOLD_REASONS: releasableBy 'partner'). A closed allowlist: a
 * new reason is refused until the registry says otherwise on purpose.
 */
export const PARTNER_RELEASABLE_REASONS: readonly string[] = Object.freeze(
  Object.keys(HOLD_REASONS).filter((r) => HOLD_REASONS[r]!.releasableBy === 'partner'),
);

/**
 * Who may release a hold with these reasons: the strictest reason wins
 * (rescreen > platform > partner). Fails CLOSED: an empty or missing list, or
 * any reason outside the registry, is 'platform' (unless a rescreen reason is
 * present, which no person may override).
 */
export function holdReleasableBy(reasons: readonly string[] | null | undefined): HoldReleasableBy {
  if (!Array.isArray(reasons) || reasons.length === 0) return 'platform';
  let out: HoldReleasableBy = 'partner';
  for (const r of reasons) {
    const e = registryEntry(r);
    if (e?.releasableBy === 'rescreen') return 'rescreen';
    if (!e || e.releasableBy === 'platform') out = 'platform';
  }
  return out;
}

/** A hold that only the automatic re-screen may lift (any rescreen reason present, e.g. LIST_UNAVAILABLE). */
export function isRescreenOnlyHold(t: { complianceReasons?: readonly string[] | null }): boolean {
  return holdReleasableBy(t.complianceReasons) === 'rescreen';
}

/**
 * SPEC §3.3 + D7: a partner admin may release ONLY a delegated partner's
 * KYC-class hold. Fails CLOSED: an unknown KYC mode, a missing partner, a
 * status other than in_review, a sanctions-blocked row, an empty or malformed
 * reasons list, ANY screening reason (isScreeningHold) or ANY reason the
 * registry does not mark 'partner' (holdReleasableBy) ⇒ false. Pure: the
 * /partner release action (the guard) and the transfer detail page (which
 * hides the button) both call it.
 *
 * M3-10 follow-up (owner, 2026-09-29): `sender` is the transfer SENDER's
 * customer row flags, read in the owner's tenant (lib/sender-screening.ts). A
 * PEP or watchlist hit on the sender (isScreeningCustomerHold) is a screening
 * matter, so it stays PLATFORM-only even when every transfer reason is
 * KYC-class. REQUIRED, and a missing row or failed lookup (null / undefined)
 * ⇒ false. Fix pack 2 review F2: `sender` carries the stamp times too, and a
 * stamped, uncleared hold refuses like a boolean hit (isScreeningCustomerHold).
 */
export function isPartnerReleasableHold(
  t: { status: string; complianceStatus?: string | null; complianceReasons?: readonly string[] | null },
  owner: { kycMode?: string | null } | null | undefined,
  sender: CustomerScreeningFlags | null | undefined,
): boolean {
  if (!owner || owner.kycMode !== 'delegated') return false;
  if (!sender || isScreeningCustomerHold(sender)) return false;
  if (t.status !== 'in_review' || t.complianceStatus === 'blocked') return false;
  const r = t.complianceReasons;
  if (!Array.isArray(r) || r.length === 0) return false;
  if (isScreeningHold({ complianceReasons: r })) return false;
  return holdReleasableBy(r) === 'partner';
}

/**
 * Fix pack 2 (R06): which customer-row screening flags make a sender hold, and
 * who may clear it. Both are platform-only.
 */
export const CUSTOMER_SCREENING_FLAGS = { watchlistHit: 'platform', pepHit: 'platform' } as const;

/**
 * Fix pack 2 (R06): is the sender's screening hold active? A hit is a
 * watchlist or PEP flag, OR a stamped flaggedAt (a stale upsert may null the
 * booleans; the stamp keeps the hold). No hit ⇒ false. A clear later than the
 * flag (or a clear with no flag time) lifts it; a tie stays held.
 */
export function senderScreeningHoldActive(
  s:
    | {
        watchlistHit?: boolean | null;
        pepHit?: boolean | null;
        screeningFlaggedAt?: string | Date | null;
        screeningClearedAt?: string | Date | null;
      }
    | null
    | undefined,
): boolean {
  if (!s) return false;
  const flaggedAt = s.screeningFlaggedAt ?? null;
  const hit = s.watchlistHit === true || s.pepHit === true || flaggedAt != null;
  if (!hit) return false;
  const clearedAt = s.screeningClearedAt ?? null;
  if (clearedAt != null) {
    if (flaggedAt == null) return false;
    const c = toMs(clearedAt);
    const f = toMs(flaggedAt);
    // An unreadable time cannot prove the clear came later: stay held.
    if (Number.isFinite(c) && Number.isFinite(f) && c > f) return false;
  }
  return true;
}

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

/** The customer-row screening fields the hold rules read (SenderScreeningFlags or a Customer). */
export interface CustomerScreeningFlags {
  watchlistHit?: boolean | null;
  pepHit?: boolean | null;
  screeningFlaggedAt?: string | Date | null;
  screeningClearedAt?: string | Date | null;
}

/**
 * Program-Fix 43 follow-up: a CUSTOMER-level screening hold — a Persona
 * watchlist/sanctions or PEP report matched (kyc-state-machine sets the flag).
 * Deciding such a customer (approve / reject / manual override) is
 * PLATFORM-only. Known residual: Persona "other" matches (e.g. adverse media)
 * set needs_review with no flag, so they are not distinguishable here.
 *
 * Fix pack 2 review F2 (A2, B1): THE partner-staff rule — a boolean hit, OR a
 * stamped screeningFlaggedAt that no LATER screeningClearedAt covers
 * (senderScreeningHoldActive; a stale whole-row saveCustomer can null the
 * booleans, the stamp survives it). A platform clear lifts the stamp only: a
 * boolean hit still refuses partner staff. The SQL twin is
 * senderClearForPartnerRelease (transfer-repo.ts); a table-driven test
 * (tests/sender-screening-hold-parity.test.ts) runs both on the same cases.
 */
export function isScreeningCustomerHold(c: CustomerScreeningFlags): boolean {
  return c.watchlistHit === true || c.pepHit === true || senderScreeningHoldActive(c);
}

/**
 * Pack 2 review R3 (H1 display truth): the one screening label for staff views
 * and the advisory KYC prompt. A boolean hit names itself (it stays as evidence
 * after a clear); otherwise the shared rule decides, so a stamped, uncleared
 * hold whose booleans a stale upsert nulled reads 'hold', never 'clear'.
 */
export function senderScreeningLabel(c: CustomerScreeningFlags): 'watchlist' | 'pep' | 'hold' | 'clear' {
  if (c.watchlistHit === true) return 'watchlist';
  if (c.pepHit === true) return 'pep';
  return isScreeningCustomerHold(c) ? 'hold' : 'clear';
}

/** Who may decide a customer's KYC: platform staff always; partner staff only without a screening hold. */
export function canDecideCustomerKyc(
  scope: { kind: 'platform' | 'partner' },
  c: CustomerScreeningFlags,
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
