import type { CurrencyCode } from './types';
import type { RedisLike } from './store';
import { logError, logWarn } from './log';

// rate.ts — the platform FX source: Frankfurter, which serves the ECB reference
// rates (one fixing per TARGET business day).
//
// FAIL CLOSED (Phase 1 Task 9). A quoted rate becomes a BINDING payout
// instruction (http-payment-provider.ts ships transfer.fxRate to the rail), so
// this module never hands out a rate it cannot vouch for:
//   • every FxRates it returns carries provenance (fetchedAt / source / asOf);
//   • a failed re-fetch serves the last good rate ONLY while it is younger than
//     FX_MAX_AGE_MS (source 'cache', logged); beyond that — or with nothing
//     cached — it THROWS RateUnavailableError;
//   • there is no static-table arm on any path. FALLBACK_FX_RATES is a display
//     table tagged source:'fallback', which fx.ts refuses to price.

export type FxSource = 'live' | 'cache' | 'fallback';

export interface FxRates {
  toInr: number; // 1 unit of source currency → INR (shown to the customer)
  toUsd: number; // 1 unit of source currency → USD (for USD-equivalent accounting)
  /** Epoch ms of the upstream fetch this rate came from. getFxRates ALWAYS sets
   *  it; optional only so hand-built literals (tests, injected fakes) compile —
   *  fx.ts gates on it whenever it is present. */
  fetchedAt?: number;
  /** 'live' = fetched inside the soft TTL; 'cache' = a re-fetch failed and this
   *  is the last good rate (≤ FX_MAX_AGE_MS old); 'fallback' = the static
   *  display table, which fx.ts refuses unconditionally. */
  source?: FxSource;
  /** The provider's fixing date (Frankfurter `date`, YYYY-MM-DD) — display only. */
  asOf?: string;
}

/** api.frankfurter.app 301-redirects every call here (live-03, verified 2026-09-21). */
export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';
/** Per-request budget. Rate fetches sit on the synchronous quote path. */
export const FX_FETCH_TIMEOUT_MS = 5_000;
/** Soft TTL: re-fetch after this (L1 = per-instance memory, L2 = shared Redis). */
const CACHE_TTL_MS = 300_000;
/** Hard ceiling: never SERVE — and fx.ts never PRICES on — a rate older than this. */
export const FX_MAX_AGE_MS = 3_600_000;
/** After a failed upstream call, do not re-dial for this long: an outage must
 *  not cost FX_FETCH_TIMEOUT_MS on every quote. Serve cache / refuse instead. */
const FAILURE_BACKOFF_MS = 30_000;
/** An L2 row stamped further in the future than this is not trusted: its age
 *  would read as negative and pass every freshness / ceiling check. The
 *  margin only absorbs ordinary clock skew between instances. */
const L2_MAX_FUTURE_SKEW_MS = 120_000;

/** The dirham has been pegged at 3.6725 per USD since 1997. Frankfurter does
 *  not serve AED at all (HTTP 404, verified 2026-09-21), so AED is DERIVED from
 *  the USD leg on every call — never fetched, never cached on its own. */
export const AED_PER_USD = 3.6725;

/** Customer-safe refusal text (no internal terms — bot-content-guard). */
export const FX_UNAVAILABLE_MESSAGE =
  'Exchange rates are temporarily unavailable — please try again in a few minutes.';
export const FX_QUOTE_EXPIRED_MESSAGE =
  'That quote has expired — please ask for a fresh quote.';

export type FxUnavailableReason =
  | 'fetch_failed'
  | 'timeout'
  | `http_${number}`
  | 'malformed_rates'
  | 'stale'
  | 'fallback_table'
  | 'stale_quote'
  | 'unsupported_currency';

/**
 * No rate of acceptable provenance and age exists. Deliberately NOT a
 * QuoteError subclass: QuoteError means "this request is invalid" (400 /
 * "keep the mid quote"); this means "we cannot price right now" (503 / refuse).
 * Every `instanceof QuoteError` handler carries an explicit sibling arm.
 */
export class RateUnavailableError extends Error {
  readonly reason: FxUnavailableReason;
  readonly currency?: CurrencyCode;
  constructor(reason: FxUnavailableReason, currency?: CurrencyCode) {
    super(reason === 'stale_quote' ? FX_QUOTE_EXPIRED_MESSAGE : FX_UNAVAILABLE_MESSAGE);
    this.name = 'RateUnavailableError';
    this.reason = reason;
    this.currency = currency;
  }
}

// DISPLAY ONLY — never priced (fx.ts refuses source:'fallback'). The typed
// Record keeps every CurrencyCode represented (the new-corridor checklist).
// Mids measured 2026-09-21 from api.frankfurter.dev/v1 (USD→INR 95.82):
// toUsd = 1/(USD→X), toInr = 95.82/(USD→X). They go stale the day they are
// typed — the ceiling in getFxRates, not this table, is the safety mechanism.
export const FALLBACK_FX_RATES: Record<CurrencyCode, FxRates> = {
  USD: { toInr: 95.82, toUsd: 1, source: 'fallback' },
  GBP: { toInr: 128.35, toUsd: 1.3395, source: 'fallback' },
  CAD: { toInr: 68.42, toUsd: 0.7141, source: 'fallback' },   // USD→CAD 1.4004
  AED: { toInr: 26.09, toUsd: 0.2723, source: 'fallback' },   // peg 3.6725
  SGD: { toInr: 75.16, toUsd: 0.7844, source: 'fallback' },   // USD→SGD 1.2748
  AUD: { toInr: 68.39, toUsd: 0.7138, source: 'fallback' },   // USD→AUD 1.401
  NZD: { toInr: 54.95, toUsd: 0.5735, source: 'fallback' },   // USD→NZD 1.7437
  INR: { toInr: 1, toUsd: 0.01044, source: 'fallback' },      // INR→USD 0.01044
  HKD: { toInr: 12.21, toUsd: 0.1275, source: 'fallback' },   // USD→HKD 7.8454 (pegged)
  MXN: { toInr: 5.574, toUsd: 0.05817, source: 'fallback' },  // USD→MXN 17.1917
};

/** Illustrative USD→INR for the decorative landing hero ONLY (never priced). */
export const FALLBACK_FX_RATE = FALLBACK_FX_RATES.USD.toInr;

interface StampedFxRates extends FxRates {
  fetchedAt: number;
  source: FxSource;
}

const cache = new Map<CurrencyCode, StampedFxRates>();
const lastFailure = new Map<CurrencyCode, { at: number; reason: FxUnavailableReason }>();

export function resetRateCacheForTests(): void {
  cache.clear();
  lastFailure.clear();
}

// ── L2 (shared Redis) ────────────────────────────────────────────────────────
// Skipped under vitest by default: unit tests stub GLOBAL fetch with a
// Frankfurter response, and the Upstash client rides the same fetch — it would
// parse the FX payload as a Redis REST reply. setFxL2ForTests injects a fake.
// Entries live for FX_MAX_AGE_MS (not the soft TTL) so a COLD instance can
// still serve the fleet's last good rate during an outage.
type FxL2 = Pick<RedisLike, 'get' | 'set'>;
let l2Override: FxL2 | null | undefined;

/** Test seam: a Map-backed fake, or null to force "no L2"; undefined restores the default. */
export function setFxL2ForTests(l2: FxL2 | null | undefined): void {
  l2Override = l2;
}

async function l2Client(): Promise<FxL2 | null> {
  if (l2Override !== undefined) return l2Override;
  if (process.env.VITEST) return null;
  try {
    const { getRedis } = await import('./redis');
    return getRedis();
  } catch {
    return null;
  }
}

const isPositiveFinite = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The provider fixing date is printed on the public landing page: keep it
 *  only when it is a plain YYYY-MM-DD (never free text from the wire / L2). */
const isoDateOrUndefined = (d: unknown): string | undefined =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;

async function l2Get(source: CurrencyCode, now: number): Promise<StampedFxRates | null> {
  try {
    const l2 = await l2Client();
    if (!l2) return null;
    const raw = await l2.get(`fx:${source}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FxRates>;
    // A row written before this deploy has no fetchedAt: ignore it (its 300s
    // Redis TTL drains it) rather than guess its age.
    if (!isPositiveFinite(parsed.toInr) || !isPositiveFinite(parsed.toUsd)) return null;
    if (typeof parsed.fetchedAt !== 'number' || !Number.isFinite(parsed.fetchedAt)) return null;
    if (parsed.fetchedAt > now + L2_MAX_FUTURE_SKEW_MS) return null;
    return {
      toInr: parsed.toInr,
      toUsd: parsed.toUsd,
      fetchedAt: parsed.fetchedAt,
      source: 'live',
      asOf: isoDateOrUndefined(parsed.asOf),
    };
  } catch {
    return null; // fail-open: no L2 just means one more upstream call
  }
}

async function l2Set(source: CurrencyCode, rates: StampedFxRates): Promise<void> {
  try {
    const l2 = await l2Client();
    if (!l2) return;
    await l2.set(`fx:${source}`, JSON.stringify(rates), { ex: FX_MAX_AGE_MS / 1000 });
  } catch {
    /* best effort */
  }
}

function newer(a: StampedFxRates | undefined, b: StampedFxRates | null): StampedFxRates | undefined {
  if (!b) return a;
  if (!a) return b;
  return b.fetchedAt > a.fetchedAt ? b : a;
}

function serveCacheOrRefuse(
  source: CurrencyCode,
  best: StampedFxRates | undefined,
  now: number,
  reason: FxUnavailableReason,
): FxRates {
  // Seconds, not ms: the scrubbing logger masks any 7+ digit run.
  const ageS = best ? Math.round((now - best.fetchedAt) / 1000) : null;
  if (best && now - best.fetchedAt <= FX_MAX_AGE_MS) {
    logWarn('fx.stale-cache', `FX provider ${reason}; serving the last good rate`, {
      currency: source, ageS, reason,
    });
    return { ...best, source: 'cache' };
  }
  logError('fx.unavailable', `FX provider ${reason}; no rate inside the ceiling — refusing`, {
    currency: source, ageS, reason,
  });
  throw new RateUnavailableError(reason, source);
}

async function fetchFromProvider(
  source: CurrencyCode,
  now: number,
): Promise<StampedFxRates | FxUnavailableReason> {
  try {
    const to = source === 'USD' ? 'INR' : 'USD,INR';
    const res = await fetch(`${FRANKFURTER_BASE_URL}/latest?from=${source}&to=${to}`, {
      signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return `http_${res.status}`;
    const data = (await res.json()) as { date?: unknown; rates?: { USD?: unknown; INR?: unknown } };
    // Frankfurter OMITS the base currency from `rates`: an INR base never
    // echoes INR (identity 1) and a USD base never echoes USD (identity 1).
    const inr = source === 'INR' ? 1 : data.rates?.INR;
    const usd = source === 'USD' ? 1 : data.rates?.USD;
    // `> 0`, not just finite: a 0 would reach usdPivotCrossRate (prs-04), and a
    // missing USD leg is a malformed response — never a static toUsd.
    if (!isPositiveFinite(inr) || !isPositiveFinite(usd)) return 'malformed_rates';
    return {
      toInr: inr,
      toUsd: usd,
      fetchedAt: now,
      source: 'live',
      asOf: isoDateOrUndefined(data.date),
    };
  } catch (err) {
    return err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
  }
}

export async function getFxRates(source: CurrencyCode): Promise<FxRates> {
  // Only the typed corridor table is ever dialed (Task 9 security review): a
  // code from an unvalidated caller never reaches the provider URL, the
  // per-instance maps or the fleet L2 — under fail-closed FX, an upstream rate
  // limit tripped by junk codes would refuse every quote platform-wide.
  if (!Object.prototype.hasOwnProperty.call(FALLBACK_FX_RATES, source)) {
    throw new RateUnavailableError('unsupported_currency', source);
  }
  if (source === 'AED') {
    const usd = await getFxRates('USD');
    // Derived, never fresher than its USD leg (same fetchedAt / source / asOf).
    return { ...usd, toUsd: 1 / AED_PER_USD, toInr: usd.toInr / AED_PER_USD };
  }

  const now = Date.now();
  const l1 = cache.get(source);
  if (l1 && now - l1.fetchedAt < CACHE_TTL_MS) return l1;

  // Shared L2 before the upstream call — one Frankfurter fetch per soft TTL
  // across the whole fleet, not per instance.
  const shared = await l2Get(source, now);
  if (shared && now - shared.fetchedAt < CACHE_TTL_MS) {
    cache.set(source, shared);
    return shared;
  }
  const best = newer(l1, shared);

  const recent = lastFailure.get(source);
  if (recent && now - recent.at < FAILURE_BACKOFF_MS) {
    return serveCacheOrRefuse(source, best, now, recent.reason);
  }

  const fetched = await fetchFromProvider(source, now);
  if (typeof fetched !== 'string') {
    cache.set(source, fetched);
    lastFailure.delete(source);
    await l2Set(source, fetched);
    return fetched;
  }
  lastFailure.set(source, { at: now, reason: fetched });
  return serveCacheOrRefuse(source, best, now, fetched);
}

/** Thin USD→INR wrapper. Throws RateUnavailableError exactly like getFxRates. */
export async function getFxRate(): Promise<number> {
  return (await getFxRates('USD')).toInr;
}

/**
 * The destination leg quote()/sourceForDest() need: undefined for an INR
 * destination (usdPivotCrossRate prices INR off the SOURCE leg's toInr and never
 * reads an INR→USD rate — fetching it would only add a way to refuse a quote
 * that does not depend on it), otherwise the destination's rates (callers pass
 * `.toUsd`). Throws RateUnavailableError exactly like getFxRates.
 */
export async function getDestinationRates(destinationCurrency: CurrencyCode): Promise<FxRates | undefined> {
  return destinationCurrency === 'INR' ? undefined : getFxRates(destinationCurrency);
}
