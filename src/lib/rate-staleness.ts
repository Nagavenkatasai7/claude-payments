import type { Db } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { FALLBACK_FX_RATES, FRANKFURTER_BASE_URL, RateUnavailableError, getFxRates } from './rate';
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
//   • ONE combined alert per severity per clock hour lists every affected
//     currency: dedupe key fx-health:<SEVERITY>:<hourBucket>. Dedupe keys are
//     forever, so the hour bucket is what lets a lasting outage alert again, and
//     the severity in the key means an earlier DEGRADED alert in the same hour
//     can never swallow a later UNAVAILABLE one;
//   • probe starts are staggered by FX_PROBE_STAGGER_MS instead of all firing
//     in the same instant.
// Worst-case wall time (9 currencies): 8 × 250 ms stagger + 5 s first attempt
// + 7 s retry = 14 s (the worker's drain start cutoff absorbs it).

/** Every currency getFxRates actually fetches (the typed table lists them all). */
export const FX_PROBE_CURRENCIES: readonly CurrencyCode[] = (
  Object.keys(FALLBACK_FX_RATES) as CurrencyCode[]
).filter((c) => c !== 'AED');

/** The probe's single retry gets slightly longer than the quote path's 5 s. */
export const FX_PROBE_RETRY_TIMEOUT_MS = 7_000;
/** Delay between successive probe STARTS (the probes still overlap). */
export const FX_PROBE_STAGGER_MS = 250;
/** A served (stale) cache younger than this is not worth paging anyone. */
export const FX_DEGRADED_ALERT_AGE_MS = 15 * 60_000;

/** The probe the worker runs: getFxRates plus ONE retry at a longer timeout. */
const probeFxRates: FxRatesFn = (c) => getFxRates(c, { retryTimeoutMs: FX_PROBE_RETRY_TIMEOUT_MS });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FxHealthSweepOptions {
  /** Delay between probe starts (default FX_PROBE_STAGGER_MS; tests pass 0). */
  staggerMs?: number;
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
  const outbox = createOutboxRepo(db);
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const results = await Promise.allSettled(
    FX_PROBE_CURRENCIES.map(async (c, i) => {
      if (staggerMs > 0 && i > 0) await sleep(i * staggerMs);
      return fx(c);
    }),
  );

  const unavailable: string[] = [];
  const degraded: string[] = [];
  for (let i = 0; i < FX_PROBE_CURRENCIES.length; i++) {
    const currency = FX_PROBE_CURRENCIES[i];
    const r = results[i];
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
  }

  let alerted = 0;
  if (unavailable.length > 0) {
    const fresh = await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: platform FX is UNAVAILABLE for ${unavailable.join(', ')} — ` +
          `every quote in these currencies is being refused. Check ${FRANKFURTER_BASE_URL}.`,
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
          `good rate; quotes will be refused once it is 60 min old. Check ${FRANKFURTER_BASE_URL}.`,
      },
      { dedupeKey: `fx-health:DEGRADED:${hourBucket}` },
    );
    if (fresh) alerted++;
  }
  return alerted;
}
