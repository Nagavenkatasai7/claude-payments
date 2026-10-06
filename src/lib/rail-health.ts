import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';

// rail-health — "is this partner's settlement rail failing right now?" for the
// best-rate router (smart-routing R0 fix B). No new table: the worker already
// raises ONE `railfail:<rail partner>:<hour bucket>` ops alert per failing rail
// per hour (outbox-worker alertRailFailing, from RAILFAIL_ALERT_MIN_ATTEMPT).
// Outbox rows are never deleted and keep dedupe_key, so the alert row doubles
// as a durable health signal. A partner with that alert in the current or the
// previous hour is skipped for new quotes; after that it competes again.

const HOUR_MS = 3_600_000;

/** The worker's hour bucket for a moment (ms since epoch). */
export const hourBucketAt = (ms: number): number => Math.floor(ms / HOUR_MS);

/** The ops-alert dedupe key the worker writes when a partner's rail is failing. Single source for both sides. */
export const railFailAlertKey = (partnerId: string, bucket: number): string => `railfail:${partnerId}:${bucket}`;

/**
 * The partners (of `partnerIds`) whose rail raised a failing alert in the
 * current or previous hour. One indexed lookup (outbox_dedupe). FAIL-OPEN:
 * routing is an optimization, so a lookup error returns an empty set.
 */
export async function recentlyFailingRails(db: DbOrTx, partnerIds: string[], now: Date): Promise<Set<string>> {
  const failing = new Set<string>();
  if (partnerIds.length === 0) return failing;
  const bucket = hourBucketAt(now.getTime());
  const keyToPartner = new Map<string, string>();
  for (const id of partnerIds) {
    keyToPartner.set(railFailAlertKey(id, bucket), id);
    keyToPartner.set(railFailAlertKey(id, bucket - 1), id);
  }
  try {
    const found = await createOutboxRepo(db).existingDedupeKeys([...keyToPartner.keys()]);
    for (const key of found) {
      const id = keyToPartner.get(key);
      if (id) failing.add(id);
    }
  } catch (err) {
    console.warn('recentlyFailingRails: lookup failed (routing fails open):', err instanceof Error ? err.message : err);
  }
  return failing;
}
