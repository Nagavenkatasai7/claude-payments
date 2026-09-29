import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { partnerGoLive } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { PartnerId } from '@/lib/types';

// partner-go-live-repo (UI redesign M3-14; read by M3-20/21). The ONE rule for "may this partner
// hold LIVE API keys": its partner_go_live row has approved_at set. Migration 0028 backfills an
// approved row ('system:0028-backfill') for every partner that existed when it was applied; a
// partner created later has no row, so it is sandbox-only until it requests and SmartRemit approves.
// Every function is keyed by partnerId (the caller passes the SESSION tenant, never a form field).
// Drizzle APIs: insert().onConflictDoNothing (node_modules/drizzle-orm/pg-core/query-builders/
// insert.d.ts:138), update().returning (update.d.ts:166).

export type GoLiveRecord = typeof partnerGoLive.$inferSelect;

export async function getGoLive(db: DbOrTx, partnerId: PartnerId): Promise<GoLiveRecord | null> {
  const rows = await db.select().from(partnerGoLive).where(eq(partnerGoLive.partnerId, partnerId)).limit(1);
  return rows[0] ?? null;
}

/** True only when approved_at IS NOT NULL. Callers treat a thrown error as "not approved" (fail closed). */
export async function isLiveApproved(db: DbOrTx, partnerId: PartnerId): Promise<boolean> {
  const rows = await db
    .select({ id: partnerGoLive.partnerId })
    .from(partnerGoLive)
    .where(and(eq(partnerGoLive.partnerId, partnerId), isNotNull(partnerGoLive.approvedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Idempotent: the FIRST request time and requester are kept; a repeat changes nothing. */
export async function requestGoLive(db: DbOrTx, partnerId: PartnerId, by: string, now: Date = new Date()): Promise<void> {
  await db.insert(partnerGoLive).values({ partnerId, requestedAt: now, requestedBy: by, updatedAt: now }).onConflictDoNothing({ target: partnerGoLive.partnerId });
  // A row that already exists without a request (e.g. the 0028 backfill) records its first request.
  await db
    .update(partnerGoLive)
    .set({ requestedAt: now, requestedBy: by, updatedAt: now })
    .where(and(eq(partnerGoLive.partnerId, partnerId), isNull(partnerGoLive.requestedAt)));
}

/**
 * Approve a REQUESTED go-live. False when nothing was requested (nothing is written). Already
 * approved → true, and the first approver and time are kept.
 */
export async function approveGoLive(db: DbOrTx, partnerId: PartnerId, by: string, now: Date = new Date()): Promise<boolean> {
  const updated = await db
    .update(partnerGoLive)
    .set({ approvedAt: now, approvedBy: by, updatedAt: now })
    .where(and(eq(partnerGoLive.partnerId, partnerId), isNotNull(partnerGoLive.requestedAt), isNull(partnerGoLive.approvedAt)))
    .returning({ id: partnerGoLive.partnerId });
  if (updated.length > 0) return true;
  return isLiveApproved(db, partnerId);
}
