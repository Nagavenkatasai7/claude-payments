import type { Db } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';

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
