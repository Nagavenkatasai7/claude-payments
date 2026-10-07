import type { CurrencyCode } from './types';
import type { RedisLike } from './store';
import { logError, logWarn } from './log';

// rate.ts — the platform FX source: the ECB reference rates (one fixing per
// TARGET business day). Two copies of the same fixing are read (Oct 7 2026
// incident: Frankfurter v1 timed out for hours from Vercel):
//   1. the ECB's own daily file (ECB_DAILY_URL) — one call carries every
//      currency per EUR, so one fetch serves the whole corridor table;
//   2. Frankfurter v1, which republishes that fixing — asked when the ECB file
//      errors, or has not answered within ECB_HEDGE_MS.
// Every rate carries the `provider` that served it (stamped on transfers).
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
  /** The provider's fixing date (ECB `time` / Frankfurter `date`, YYYY-MM-DD) — display only. */
  asOf?: string;
  /** Which source served this rate: ECB_PROVIDER_ID or FX_PROVIDER_ID (Frankfurter).
   *  Optional so hand-built literals compile; getFxRates sets it on every fetch. */
  provider?: string;
}

/** api.frankfurter.app 301-redirects every call here (live-03, verified 2026-09-21). */
export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';
/** Step 0 FX-7: the provider id stamped on transfers.fx_provider for a platform
 *  rate Frankfurter served (and for drafts made before rates named a provider). */
export const FX_PROVIDER_ID = 'frankfurter-v1-ecb';
/** The ECB's own daily reference-rate file: EUR base, every currency, one call. */
export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
/** The provider id stamped on transfers.fx_provider for a rate the ECB file served. */
export const ECB_PROVIDER_ID = 'ecb-eurofxref-daily';
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set([FX_PROVIDER_ID, ECB_PROVIDER_ID]);

/** A provider id a transfer row may carry: one known id, or known ids joined
 *  with '+' (legsProvenance, when two legs came from different sources). */
export function isKnownFxProvider(p: unknown): p is string {
  return typeof p === 'string' && p !== '' && p.split('+').every((id) => KNOWN_PROVIDERS.has(id));
}
/** When the ECB file has not answered in this time, Frankfurter is asked too and
 *  the first good answer wins. Worst case (both silent) is this plus one timeout. */
export const ECB_HEDGE_MS = 1_500;
/** One ECB file serves every currency asked for inside this window (the health
 *  probe asks for 8 at once). A failed file is never reused. */
const ECB_FILE_REUSE_MS = 60_000;
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
  // Step 0 FX-1: the provider's fixing date is 3+ business days behind (fx-fixing.ts).
  | 'stale_fixing'
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
/** The ECB file in flight or fetched inside ECB_FILE_REUSE_MS (shared by currencies). */
let ecbFile: { at: number; result: Promise<FetchedEcbFile | FxUnavailableReason> } | null = null;
const lastFailure = new Map<CurrencyCode, { at: number; reason: FxUnavailableReason }>();
/** Step 0 FX-1 measurement: the newest fixing date this instance has fetched, per currency. */
const lastSeenAsOf = new Map<CurrencyCode, string>();

export function resetRateCacheForTests(): void {
  cache.clear();
  lastFailure.clear();
  lastSeenAsOf.clear();
  ecbFile = null;
}

// ── The ECB file source ─────────────────────────────────────────────────────
// Off under vitest by default, like L2: about 50 suites stub GLOBAL fetch with a
// Frankfurter-shaped answer (some per call, in order), and an extra ECB call
// would consume it. setEcbSourceForTests(true) turns it on for its own tests.
let ecbOverride: boolean | undefined;

/** Test seam: true / false forces the ECB source on / off; undefined restores the default. */
export function setEcbSourceForTests(on: boolean | undefined): void {
  ecbOverride = on;
}

function ecbSourceOn(): boolean {
  return ecbOverride ?? !process.env.VITEST;
}

/**
 * Step 0 FX-1 measurement: one warn line the first time THIS instance fetches
 * a fixing date newer than the last one it saw (never on its first sighting —
 * a cold start is not an advance). The UTC time of the line is when the new
 * ECB fixing reached us through Frankfurter, which validates the 17:00 / 06:00
 * UTC cutoffs (fx-fixing.ts) before FX_FIXING_GATE_ENABLED is turned on.
 */
function noteFixingDate(source: CurrencyCode, asOf: string | undefined, now: number): void {
  if (!asOf) return;
  const prev = lastSeenAsOf.get(source);
  if (prev !== undefined && asOf <= prev) return;
  lastSeenAsOf.set(source, asOf);
  if (prev === undefined) return;
  logWarn('fx.fixing-advanced', 'FX provider fixing date advanced', {
    currency: source, asOf, seenAtUtc: new Date(now).toISOString(),
  });
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
      // Stamped on transfer rows: only a known id, never free text from L2.
      provider: typeof parsed.provider === 'string' && KNOWN_PROVIDERS.has(parsed.provider) ? parsed.provider : undefined,
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

async function fetchFromFrankfurter(
  source: CurrencyCode,
  now: number,
  timeoutMs: number,
): Promise<StampedFxRates | FxUnavailableReason> {
  try {
    const to = source === 'USD' ? 'INR' : 'USD,INR';
    const res = await fetch(`${FRANKFURTER_BASE_URL}/latest?from=${source}&to=${to}`, {
      signal: AbortSignal.timeout(timeoutMs),
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
      provider: FX_PROVIDER_ID,
    };
  } catch (err) {
    return failureReason(err);
  }
}

function failureReason(err: unknown): FxUnavailableReason {
  return err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
}

/** The parsed ECB file: units of each currency per 1 EUR, and the fixing date. */
export interface EcbFile {
  asOf?: string;
  perEur: Map<string, number>;
}

/**
 * Parse eurofxref-daily.xml. Only `<Cube time='…'>` and
 * `<Cube currency='XXX' rate='n'/>` are read; a rate that is not a positive
 * number is dropped. Malformed unless both USD and INR are present, because
 * every cross rate needs them.
 */
export function parseEcbDaily(xml: string): EcbFile | 'malformed_rates' {
  const perEur = new Map<string, number>();
  const cube = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([^'"]*)['"]\s*\/>/g;
  for (const m of xml.matchAll(cube)) {
    // Plain decimals only: Number() would also accept '0x1A' or '1e2'.
    if (!/^\d+(\.\d+)?$/.test(m[2])) continue;
    const rate = Number(m[2]);
    if (isPositiveFinite(rate)) perEur.set(m[1], rate);
  }
  if (!perEur.has('USD') || !perEur.has('INR')) return 'malformed_rates';
  const time = /<Cube\s+time=['"]([^'"]*)['"]/.exec(xml);
  return { asOf: isoDateOrUndefined(time?.[1]), perEur };
}

/** A parsed file and when it was fetched (a reused file keeps its own time). */
type FetchedEcbFile = EcbFile & { fetchedAt: number };

async function fetchEcbFile(now: number, timeoutMs: number): Promise<FetchedEcbFile | FxUnavailableReason> {
  try {
    const res = await fetch(ECB_DAILY_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return `http_${res.status}`;
    const file = parseEcbDaily(await res.text());
    return typeof file === 'string' ? file : { ...file, fetchedAt: now };
  } catch (err) {
    return failureReason(err);
  }
}

/** One ECB file per ECB_FILE_REUSE_MS for every currency; a failure is dropped
 *  as soon as it settles, so the next refresh dials again. */
function loadEcbFile(now: number, timeoutMs: number): Promise<FetchedEcbFile | FxUnavailableReason> {
  if (ecbFile && now - ecbFile.at < ECB_FILE_REUSE_MS) return ecbFile.result;
  const entry = { at: now, result: fetchEcbFile(now, timeoutMs) };
  ecbFile = entry;
  void entry.result.then((r) => {
    if (typeof r === 'string' && ecbFile === entry) ecbFile = null;
  });
  return entry.result;
}

/** Six significant digits: the ECB publishes 5 to 6, so this keeps every digit
 *  the data carries and drops only float noise from the division. */
const sig6 = (x: number): number => Number(x.toPrecision(6));

function ecbRatesFor(source: CurrencyCode, file: FetchedEcbFile): StampedFxRates | FxUnavailableReason {
  const perSource = file.perEur.get(source);
  const usd = file.perEur.get('USD');
  const inr = file.perEur.get('INR');
  if (!isPositiveFinite(perSource) || !isPositiveFinite(usd) || !isPositiveFinite(inr)) return 'malformed_rates';
  return {
    toInr: source === 'INR' ? 1 : sig6(inr / perSource),
    toUsd: source === 'USD' ? 1 : sig6(usd / perSource),
    fetchedAt: file.fetchedAt,
    source: 'live',
    asOf: file.asOf,
    provider: ECB_PROVIDER_ID,
  };
}

type FetchResult = StampedFxRates | FxUnavailableReason;

/** The first good answer of the two; when both fail, the reason of the last to fail. */
function firstGood(a: Promise<FetchResult>, b: Promise<FetchResult>): Promise<FetchResult> {
  return new Promise((resolve) => {
    let pending = 2;
    const settle = (r: FetchResult) => {
      pending -= 1;
      if (typeof r !== 'string' || pending === 0) resolve(r);
    };
    void a.then(settle);
    void b.then(settle);
  });
}

/**
 * One upstream attempt across both sources: the ECB file first; Frankfurter
 * when the ECB file errors, lacks the currency, or is still silent after
 * ECB_HEDGE_MS. Never rejects. Each source gets the full timeout.
 */
async function fetchFromProvider(
  source: CurrencyCode,
  now: number,
  timeoutMs: number = FX_FETCH_TIMEOUT_MS,
): Promise<FetchResult> {
  if (!ecbSourceOn()) return fetchFromFrankfurter(source, now, timeoutMs);
  const fromEcb = loadEcbFile(now, timeoutMs).then((f) => (typeof f === 'string' ? f : ecbRatesFor(source, f)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hedge = new Promise<'hedge'>((resolve) => {
    timer = setTimeout(() => resolve('hedge'), ECB_HEDGE_MS);
  });
  const first = await Promise.race([fromEcb, hedge]);
  clearTimeout(timer);
  if (first !== 'hedge' && typeof first !== 'string') return first;

  const fromFrankfurter = fetchFromFrankfurter(source, now, timeoutMs);
  const result = first === 'hedge' ? await firstGood(fromEcb, fromFrankfurter) : await fromFrankfurter;
  if (typeof result !== 'string' && result.provider !== ECB_PROVIDER_ID) {
    logWarn('fx.ecb-fallback', 'ECB file did not serve the rate; Frankfurter did', {
      currency: source, reason: first === 'hedge' ? 'slow' : first,
    });
  }
  return result;
}

/**
 * Opt-in knobs for the ops health probe (rate-staleness.ts) ONLY. The quote
 * path never passes options, so it keeps today's contract exactly: one
 * upstream attempt at FX_FETCH_TIMEOUT_MS, FAILURE_BACKOFF_MS, FX_MAX_AGE_MS.
 */
export interface FxFetchOptions {
  /** When set, a failed first attempt is retried ONCE with this timeout before
   *  the fetch counts as failed. The first failure is still recorded in the
   *  backoff map before the retry (so concurrent quotes back off as today), and
   *  a failed retry falls through to the same serve-cache-or-refuse ceiling. */
  retryTimeoutMs?: number;
}

export async function getFxRates(source: CurrencyCode, opts: FxFetchOptions = {}): Promise<FxRates> {
  // Only the typed corridor table is ever dialed (Task 9 security review): a
  // code from an unvalidated caller never reaches the provider URL, the
  // per-instance maps or the fleet L2 — under fail-closed FX, an upstream rate
  // limit tripped by junk codes would refuse every quote platform-wide.
  if (!Object.prototype.hasOwnProperty.call(FALLBACK_FX_RATES, source)) {
    throw new RateUnavailableError('unsupported_currency', source);
  }
  if (source === 'AED') {
    const usd = await getFxRates('USD', opts);
    // Derived, never fresher than its USD leg (same fetchedAt / source / asOf).
    return { ...usd, toUsd: 1 / AED_PER_USD, toInr: usd.toInr / AED_PER_USD };
  }

  const now = Date.now();
  const l1 = cache.get(source);
  if (l1 && now - l1.fetchedAt < CACHE_TTL_MS) return l1;

  // Shared L2 before the upstream call — one upstream fetch per soft TTL
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

  let fetched = await fetchFromProvider(source, now);
  if (typeof fetched === 'string' && opts.retryTimeoutMs !== undefined) {
    lastFailure.set(source, { at: now, reason: fetched });
    fetched = await fetchFromProvider(source, now, opts.retryTimeoutMs);
  }
  if (typeof fetched !== 'string') {
    noteFixingDate(source, fetched.asOf, now);
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
