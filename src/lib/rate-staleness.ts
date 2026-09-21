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

// ── Platform FX health (Task 9) ─────────────────────────────────────────────
// getFxRates has no Db handle, so the FX alert is raised HERE, on the worker
// heartbeat, by PROBING the platform FX for every currency Frankfurter serves.
// A probe that comes back source:'cache' (a re-fetch failed; the last good rate
// is being served) or throws RateUnavailableError (quotes are being REFUSED)
// enqueues ONE deduped ops.alert per currency per clock hour — dedupe keys are
// forever, so the hour bucket is what lets a lasting outage alert again.
// AED is derived from USD (never fetched), so probing USD covers it.

/** Every currency getFxRates actually fetches (the typed table lists them all). */
export const FX_PROBE_CURRENCIES: readonly CurrencyCode[] = (
  Object.keys(FALLBACK_FX_RATES) as CurrencyCode[]
).filter((c) => c !== 'AED');

/**
 * Enqueue one deduped ops alert per currency whose platform FX is degraded
 * (stale cache) or unavailable (refusing). Returns the number of NEW alerts.
 */
export async function sweepFxHealth(
  db: Db,
  fx: FxRatesFn = getFxRates,
  now: Date = new Date(),
): Promise<number> {
  const outbox = createOutboxRepo(db);
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const results = await Promise.allSettled(FX_PROBE_CURRENCIES.map((c) => fx(c)));
  let alerted = 0;
  for (let i = 0; i < FX_PROBE_CURRENCIES.length; i++) {
    const currency = FX_PROBE_CURRENCIES[i];
    const r = results[i];
    let state: string | null = null;
    if (r.status === 'rejected') {
      const reason = r.reason instanceof RateUnavailableError ? r.reason.reason : 'error';
      state = `UNAVAILABLE (${reason}) — every quote in ${currency} is being refused`;
    } else if (r.value.source === 'cache') {
      state = 'DEGRADED — serving the last good rate; quotes will be refused once it is 60 min old';
    }
    if (!state) continue;
    const fresh = await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: platform FX for ${currency} is ${state}. ` +
          `Check ${FRANKFURTER_BASE_URL}.`,
      },
      { dedupeKey: `fx-health:${currency}:${hourBucket}` },
    );
    if (fresh) alerted++;
  }
  return alerted;
}
