import { assertLegsUsable, usdPivotCrossRate } from './fx';
import { FX_MAX_AGE_MS, getDestinationRates, getFxRates, RateUnavailableError, type FxRates } from './rate';
import type { CurrencyCode, Transfer } from './types';

// minted-rate — Step 0 FX-2: is an EXISTING transfer's rate still payable?
//
// A transfer minted earlier (a scheduled run's link, a re-opened link after a
// failed capture) carries the rate it was minted at, and paying it later sends
// that rate to the rail as a BINDING payout instruction. The pay route
// (api/pay/[transferId]/route.ts, behind FX_PAY_RATE_CHECK_ENABLED) asks this
// module before the OTP; the caller decides which rows reach it (consumer,
// awaiting_payment, uncaptured, not partner-API-minted).
//
// Rules, in order:
//   1. inside the lock (default: FX_MAX_AGE_MS from the rate's fetch time, else
//      createdAt) → OK, no rate fetch;
//   2. a best-rate ROUTED row past the lock → refuse 'routed_stale' (the
//      partner's offer is gone; the platform mid says nothing about it);
//   3. otherwise fetch both legs (the fixing-date refusal applies here even
//      while FX_FIXING_GATE_ENABLED is off — N12) and refuse 'drift' when the
//      current cross-rate moved more than MINTED_RATE_DRIFT_TOLERANCE either way.
// RateUnavailableError propagates (the route answers 503 fx_unavailable).

/** How long a minted rate is honoured without a re-check, and from when. */
export interface MintedRateLock {
  lockMs: number;
  anchor: 'fx' | 'created';
}

export const DEFAULT_MINTED_RATE_LOCK: MintedRateLock = { lockMs: FX_MAX_AGE_MS, anchor: 'fx' };

/** Step 3 (rate orders) overrides THIS resolver only. */
export function mintedRateLockFor(_t: Transfer): MintedRateLock {
  return DEFAULT_MINTED_RATE_LOCK;
}

/** 0.5% (owner decision, Step 0 Q2). */
export const MINTED_RATE_DRIFT_TOLERANCE = 0.005;

export type MintedRateRefusal = { ok: false; reason: 'routed_stale' } | { ok: false; reason: 'drift'; driftBps: number };
export type MintedRateResult = { ok: true } | MintedRateRefusal;
export type MintedRateVerdict = MintedRateResult | { needsRate: true };

/**
 * Pure verdict. `current` is the current source→destination cross-rate, or
 * null when it has not been fetched (then a row past the lock that is not
 * routed answers `{ needsRate: true }`).
 */
export function mintedRateVerdict(
  t: Transfer,
  now: number,
  current: number | null,
  lock: MintedRateLock = mintedRateLockFor(t),
): MintedRateVerdict {
  const createdAt = Date.parse(t.createdAt);
  const fxAt = t.fxFetchedAt ? Date.parse(t.fxFetchedAt) : Number.NaN;
  const anchorAt = lock.anchor === 'fx' && Number.isFinite(fxAt) ? fxAt : createdAt;
  if (Number.isFinite(anchorAt) && now - anchorAt <= lock.lockMs) return { ok: true };
  if (t.settlementPartnerId) return { ok: false, reason: 'routed_stale' };
  if (current === null || !Number.isFinite(current) || current <= 0) return { needsRate: true };
  const drift = Math.abs(t.fxRate - current) / current;
  if (drift <= MINTED_RATE_DRIFT_TOLERANCE) return { ok: true };
  return { ok: false, reason: 'drift', driftBps: Math.round(drift * 10_000) };
}

export interface MintedRateDeps {
  getFxRates: (c: CurrencyCode) => Promise<FxRates>;
  getDestinationRates: (c: CurrencyCode) => Promise<FxRates | undefined>;
}

const defaultDeps: MintedRateDeps = { getFxRates, getDestinationRates };

/**
 * The verdict, fetching the current rate only when rule 3 needs it. Throws
 * RateUnavailableError when no usable rate exists (outage, stale, frozen feed).
 */
export async function checkMintedRate(
  t: Transfer,
  now: number = Date.now(),
  deps: MintedRateDeps = defaultDeps,
): Promise<MintedRateResult> {
  const first = mintedRateVerdict(t, now, null);
  if (!('needsRate' in first)) return first;
  const src = await deps.getFxRates(t.sourceCurrency);
  const dest = await deps.getDestinationRates(t.destinationCurrency);
  assertLegsUsable(src, dest, now, { forceFixingGate: true });
  const current = usdPivotCrossRate(src, t.destinationCurrency, dest?.toUsd);
  const verdict = mintedRateVerdict(t, now, current);
  // A finite positive cross-rate always yields a final verdict; anything else
  // is a malformed rate: never a pass, never a cancel (the route answers 503).
  if ('needsRate' in verdict) throw new RateUnavailableError('malformed_rates', t.destinationCurrency);
  return verdict;
}
