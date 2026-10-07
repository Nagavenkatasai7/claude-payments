import type { Db } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { ECB_DAILY_URL, FALLBACK_FX_RATES, FRANKFURTER_BASE_URL, RateUnavailableError, getFxRates } from './rate';

/** Both rate sources: an alert fires only when neither served the rate. */
const CHECK_SOURCES = `Check ${ECB_DAILY_URL} and ${FRANKFURTER_BASE_URL}.`;
import { FIXING_ALERT_LAG, FIXING_REFUSE_LAG, fixingLagBusinessDays } from './fx-fixing';
import { env } from './env';
import { logWarn } from './log';
import type { RedisLike } from './store';
import type { FxRatesFn } from './corridor-demand';
import type { CurrencyCode } from './types';

// rate-staleness — the pricing safety net. A partner that pushed a rate and
// then went quiet silently stops competing the moment expiresAt lapses
// (effectiveRateFor refuses stale pushes); selection falls back to margin or
// the platform mid, so MONEY is never at risk. This sweep makes the silence
// VISIBLE: each lapsed push raises exactly one deduped ops alert.
//
// Dedupe contract: outbox dedupe keys are forever (unique index; done rows
// keep theirs), so the key embeds the rate's expiresAt epoch —
//   stale-rate:<partnerId>:<src><dest>:<expiresAtEpoch>
// One expiry alerts exactly once no matter how often the sweep runs, while a
// re-pushed-then-expired rate (new expiresAt ⇒ new epoch) alerts again.

/**
 * Enqueue one deduped ops alert per expired pushed rate. Returns the number of
 * NEW alerts enqueued (re-runs over the same expiries return 0).
 */
export async function sweepStaleRates(db: Db, now: Date = new Date()): Promise<number> {
  const expired = await createPartnerRateRepo(db).listExpired(now);
  const outbox = createOutboxRepo(db);
  let alerted = 0;
  for (const r of expired) {
    if (!r.expiresAt) continue; // listExpired only returns pushed rates; belt-and-braces
    const corridor = `${r.sourceCurrency}${r.destinationCurrency}`;
    const fresh = await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: partner ${r.partnerId}'s pushed rate for ` +
          `${r.sourceCurrency}→${r.destinationCurrency} expired at ${r.expiresAt} ` +
          `and has not been re-pushed — it no longer competes (margin/platform pricing applies).`,
      },
      { dedupeKey: `stale-rate:${r.partnerId}:${corridor}:${Date.parse(r.expiresAt)}` },
    );
    if (fresh) alerted++;
  }
  return alerted;
}

// ── Platform FX health (Task 9, alert-noise fix R9) ──────────────────────────
// getFxRates has no Db handle, so the FX alert is raised HERE, on the worker
// heartbeat, by PROBING the platform FX for every currency Frankfurter serves.
// AED is derived from USD (never fetched), so probing USD covers it.
//
// R9: one slow Frankfurter response used to raise ~8 per-currency DEGRADED
// alerts an hour while no quote was ever refused. Now:
//   • the DEFAULT probe asks getFxRates for ONE retry at FX_PROBE_RETRY_TIMEOUT_MS
//     before a fetch counts as failed (the quote path never passes that option);
//   • DEGRADED (a stale cache is being served) alerts only once the served rate
//     is ≥ FX_DEGRADED_ALERT_AGE_MS old; UNAVAILABLE (quotes REFUSED) alerts at once;
//     (Oct 6 alerts) 45 min, not 15: the probe runs every 30 min and nothing
//     else refreshes the non-USD legs, so ONE missed probe always served a
//     ~30-min-old rate and paged. 45 min means "one more miss refuses quotes";
//   • ONE combined alert per severity per clock hour lists every affected
//     currency: dedupe key fx-health:<SEVERITY>:<hourBucket>. Dedupe keys are
//     forever, so the hour bucket is what lets a lasting outage alert again, and
//     the severity in the key means an earlier DEGRADED alert in the same hour
//     can never swallow a later UNAVAILABLE one;
//   • probe starts are staggered by FX_PROBE_STAGGER_MS instead of all firing
//     in the same instant.
// Worst-case wall time (9 currencies): 8 × 250 ms stagger + 6.5 s first attempt
// + 8.5 s retry = 17 s (each attempt may wait ECB_HEDGE_MS before Frankfurter
// is asked; the worker's drain start cutoff absorbs it).
//
// Step 0 FX-4: a FROZEN feed answers every probe (fetchedAt is fresh), so the
// provider's fixing date (`asOf`) is checked too (fx-fixing.ts):
//   • ALERT-lag >= 1 (a fixing due at 17:00 UTC has not arrived) → ONE FIXING
//     alert per (asOf, lag), dedupe key fx-health:FIXING:<asOf>:<lag>: one alert
//     per overdue fixing, never one per hour;
//   • with FX_FIXING_GATE_ENABLED and REFUSE-lag >= FIXING_REFUSE_LAG, quotes in
//     that currency ARE refused (fx.ts 'stale_fixing'), so it is listed as
//     UNAVAILABLE too;
//   • a probe with no asOf cannot be judged: one fx.no-fixing-date warn line.

/** Every currency getFxRates actually fetches (the typed table lists them all). */
export const FX_PROBE_CURRENCIES: readonly CurrencyCode[] = (
  Object.keys(FALLBACK_FX_RATES) as CurrencyCode[]
).filter((c) => c !== 'AED');

/** The probe's single retry gets slightly longer than the quote path's 5 s. */
export const FX_PROBE_RETRY_TIMEOUT_MS = 7_000;
/** Delay between successive probe STARTS (the probes still overlap). */
export const FX_PROBE_STAGGER_MS = 250;
/** A served (stale) cache younger than this is not worth paging anyone: 15 min
 *  before FX_MAX_AGE_MS (60 min) refuses quotes, and older than one missed
 *  30-min probe. */
export const FX_DEGRADED_ALERT_AGE_MS = 45 * 60_000;

// ── FX re-check (Oct 6 alerts) ───────────────────────────────────────────────
// A failed probe used to wait 30 min for the next one, so two misses in a row
// reached the 60-min refusal ceiling. Now every sweep writes the currencies it
// could not refresh to FX_RECHECK_KEY (Redis, comma-separated; '' = none), and
// the per-minute cron re-checks ONLY those every FX_RECHECK_PERIOD_MIN
// (worker-cadence.ts shouldRecheckFx). The re-check needs no Neon: getFxRates
// refreshes the shared L2. Neon is touched only when a re-check must enqueue a
// DEGRADED / UNAVAILABLE alert (same dedupe keys as the sweep). Fail-open: a
// Redis error loses a re-check, and the :17/:47 sweep still runs.

/** Redis key: the currencies the last sweep or re-check could not refresh. */
export const FX_RECHECK_KEY = 'fx:probe-retry';
/** Outlives one backstop period; every sweep rewrites it. */
const FX_RECHECK_TTL_SEC = 35 * 60;

/** The two Upstash commands the re-check list uses (automaticDeserialization off). */
export type FxRecheckRedis = Pick<RedisLike, 'get' | 'set'>;

/** The probe the worker runs: getFxRates plus ONE retry at a longer timeout. */
const probeFxRates: FxRatesFn = (c) => getFxRates(c, { retryTimeoutMs: FX_PROBE_RETRY_TIMEOUT_MS });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FxHealthSweepOptions {
  /** Delay between probe starts (default FX_PROBE_STAGGER_MS; tests pass 0). */
  staggerMs?: number;
  /** Probe only these (default FX_PROBE_CURRENCIES). */
  currencies?: readonly CurrencyCode[];
  /** When set, the currencies this sweep could not refresh (a served cache or
   *  a refusal) are written to FX_RECHECK_KEY; '' when every probe was live. */
  recheck?: FxRecheckRedis;
  /** The frozen-feed (FIXING) check (default true; the re-check skips it). */
  fixingCheck?: boolean;
}

async function writeRecheckList(redis: FxRecheckRedis, currencies: readonly CurrencyCode[]): Promise<void> {
  try {
    await redis.set(FX_RECHECK_KEY, currencies.join(','), { ex: FX_RECHECK_TTL_SEC });
  } catch (err) {
    logWarn('fx.recheck', 'FX re-check list write failed (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Probe every fetched currency and enqueue at most ONE deduped ops alert per
 * severity (UNAVAILABLE / DEGRADED) per clock hour, listing the affected
 * currencies. Returns the number of NEW alerts.
 */
export async function sweepFxHealth(
  db: Db,
  fx: FxRatesFn = probeFxRates,
  now: Date = new Date(),
  opts: FxHealthSweepOptions = {},
): Promise<number> {
  const staggerMs = opts.staggerMs ?? FX_PROBE_STAGGER_MS;
  const currencies = opts.currencies ?? FX_PROBE_CURRENCIES;
  const fixingCheck = opts.fixingCheck ?? true;
  const outbox = createOutboxRepo(db);
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const results = await Promise.allSettled(
    currencies.map(async (c, i) => {
      if (staggerMs > 0 && i > 0) await sleep(i * staggerMs);
      return fx(c);
    }),
  );

  const unavailable: string[] = [];
  const degraded: string[] = [];
  const fixing = new Map<string, { asOf: string; lag: number; currencies: string[] }>();
  const undated: string[] = [];
  const notRefreshed: CurrencyCode[] = [];
  for (let i = 0; i < currencies.length; i++) {
    const currency = currencies[i];
    const r = results[i];
    if (r.status === 'rejected' || r.value.source === 'cache') notRefreshed.push(currency);
    if (r.status === 'rejected') {
      const reason = r.reason instanceof RateUnavailableError ? r.reason.reason : 'error';
      unavailable.push(`${currency} (${reason})`);
    } else if (r.value.source === 'cache') {
      const fetchedAt = r.value.fetchedAt;
      // No fetchedAt ⇒ age unknowable ⇒ alert rather than hide it.
      if (typeof fetchedAt !== 'number') {
        degraded.push(`${currency} (age unknown)`);
      } else if (now.getTime() - fetchedAt >= FX_DEGRADED_ALERT_AGE_MS) {
        degraded.push(`${currency} (${Math.floor((now.getTime() - fetchedAt) / 60_000)} min old)`);
      }
    }
    if (r.status === 'fulfilled' && fixingCheck) {
      const asOf = r.value.asOf;
      const lag = asOf === undefined ? null : fixingLagBusinessDays(asOf, now.getTime(), 'alert');
      if (asOf === undefined || lag === null) {
        undated.push(currency);
      } else {
        if (lag >= FIXING_ALERT_LAG) {
          const key = `${asOf}:${lag}`;
          const group = fixing.get(key) ?? { asOf, lag, currencies: [] };
          group.currencies.push(currency);
          fixing.set(key, group);
        }
        const refuseLag = fixingLagBusinessDays(asOf, now.getTime(), 'refuse') ?? 0;
        if (env.fxFixingGateEnabled && refuseLag >= FIXING_REFUSE_LAG) {
          unavailable.push(`${currency} (stale_fixing)`);
        }
      }
    }
  }
  if (opts.recheck) await writeRecheckList(opts.recheck, notRefreshed);
  if (undated.length > 0) {
    logWarn('fx.no-fixing-date', 'FX probe returned no fixing date; the frozen-feed check cannot run', {
      currencies: undated.join(','),
    });
  }

  let alerted = 0;
  if (unavailable.length > 0) {
    const fresh = await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: platform FX is UNAVAILABLE for ${unavailable.join(', ')} — ` +
          `every quote in these currencies is being refused. ${CHECK_SOURCES}`,
      },
      { dedupeKey: `fx-health:UNAVAILABLE:${hourBucket}` },
    );
    if (fresh) alerted++;
  }
  if (degraded.length > 0) {
    const fresh = await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: platform FX is DEGRADED for ${degraded.join(', ')} — serving the last ` +
          `good rate; quotes will be refused once it is 60 min old. ${CHECK_SOURCES}`,
      },
      { dedupeKey: `fx-health:DEGRADED:${hourBucket}` },
    );
    if (fresh) alerted++;
  }
  for (const g of fixing.values()) {
    const fresh = await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: platform FX FIXING is ${g.lag} business day(s) behind for ${g.currencies.join(', ')} — ` +
          `the latest ECB fixing we have is ${g.asOf}. ` +
          (env.fxFixingGateEnabled
            ? `Quotes are refused once ${FIXING_REFUSE_LAG} fixings are overdue. `
            : `The fixing gate is off, so quotes still price. `) +
          CHECK_SOURCES,
      },
      { dedupeKey: `fx-health:FIXING:${g.asOf}:${g.lag}` },
    );
    if (fresh) alerted++;
  }
  return alerted;
}

/** The re-check runs every few minutes, so it takes the quote path's single
 *  5 s attempt (no retry of its own). */
const recheckFxRates: FxRatesFn = (c) => getFxRates(c);

/**
 * Re-probe ONLY the currencies the last sweep (or re-check) could not refresh,
 * and keep FX_RECHECK_KEY current. Nothing listed ⇒ one Redis GET and nothing
 * else (no Frankfurter call, no Neon). `getDb` is called only when something
 * is listed, and the database is only queried when an alert must be enqueued.
 * Returns the number of NEW alerts. Never throws on a Redis error.
 */
export async function recheckFailedFx(
  getDb: () => Db,
  redis: FxRecheckRedis,
  fx: FxRatesFn = recheckFxRates,
  now: Date = new Date(),
  opts: Pick<FxHealthSweepOptions, 'staggerMs'> = {},
): Promise<number> {
  let raw: string | null;
  try {
    raw = await redis.get(FX_RECHECK_KEY);
  } catch (err) {
    logWarn('fx.recheck', 'FX re-check list read failed (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  // Only codes the probe table knows ever reach the provider URL.
  const listed = new Set((raw ?? '').split(','));
  const currencies = FX_PROBE_CURRENCIES.filter((c) => listed.has(c));
  if (currencies.length === 0) return 0;
  return sweepFxHealth(getDb(), fx, now, { ...opts, currencies, recheck: redis, fixingCheck: false });
}
