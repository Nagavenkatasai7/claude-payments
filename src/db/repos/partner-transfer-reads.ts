import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { auditEvents, fundingEvents, outbox } from '@/db/schema';
import { createTransferRepo, type Page } from './transfer-repo';
import { TIMELINE_AUDIT_ACTIONS, isTransferId, type FundingEventInput, type RailRow, type TimelineAuditRow, type TransferEnv } from '@/lib/partner-transfers';
import type { PartnerId, Transfer, TransferStatus } from '@/lib/types';

// partner-transfer-reads (UI redesign M3-5): the /partner Transfers pages' READS. Read-only; masked
// ledger reads only (never a decrypting read). Every function takes the partner id FIRST and
// REQUIRED: the pages pass the SESSION tenant (requirePartnerStaff), never request input. A new file
// so the shared repos are untouched. (M3-4's tenant-audit-repo carries a general subject reader;
// this file keeps its own narrow one so the two changes cannot collide.)

const TIMELINE_LIMIT = 100;
const FUNDING_EVENTS_LIMIT = 20;
// The rail effect rows for one transfer (settlement.ts / reconcile.ts dedupe keys; unique by key).
const RAIL_KEYS = (id: string) => [`instruct:${id}`, `reinstruct:${id}`, `mocksettle:${id}`];

function requireTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('partner-transfer-reads: a tenant is required');
}

/** One keyset page of THIS tenant's transfers in one environment (masked rows). */
export async function listPartnerTransfers(
  db: DbOrTx,
  partnerId: PartnerId,
  req: { limit: number; cursor?: string; status?: TransferStatus; environment: TransferEnv },
): Promise<Page<Transfer>> {
  requireTenant(partnerId);
  const limit = Math.min(Math.max(1, Math.trunc(req.limit) || 1), 50);
  return createTransferRepo(db).adminList({ limit, cursor: req.cursor, status: req.status, environment: req.environment, partnerId });
}

/** One of THIS tenant's transfers by id (masked), or null for a missing OR foreign id. */
export async function getPartnerTransfer(db: DbOrTx, partnerId: PartnerId, id: unknown): Promise<Transfer | null> {
  requireTenant(partnerId);
  if (!isTransferId(id)) return null;
  const t = await createTransferRepo(db).getOwnedTransfer(partnerId, id);
  return t && t.partnerId === partnerId ? t : null;
}

/**
 * Merge plan 2b: THIS tenant's transfers with a refund in any non-'none' state (requested, pending,
 * completed, failed), newest first. Masked rows (the default read): no decrypted destination or
 * legal name. The tenant guard keeps this from ever becoming the unscoped all-tenant feed.
 */
export async function listPartnerRefunds(db: DbOrTx, partnerId: PartnerId): Promise<Transfer[]> {
  requireTenant(partnerId);
  const rows = await createTransferRepo(db).listActiveRefunds({ partnerId });
  return rows.filter((t) => t.partnerId === partnerId);
}

export interface PartnerTransferDetail {
  transfer: Transfer;
  audit: TimelineAuditRow[];
  rail: RailRow[];
  fundingEvents: FundingEventInput[];
}

/**
 * The detail page's data. The tenant check comes FIRST: the outbox has no partner column, so it is
 * read only by the id of a transfer this tenant owns, and only status / attempts / created_at
 * (never the payload or last_error). Audit and funding rows carry partner_id in the WHERE.
 */
export async function loadPartnerTransferDetail(db: DbOrTx, partnerId: PartnerId, id: unknown): Promise<PartnerTransferDetail | null> {
  const transfer = await getPartnerTransfer(db, partnerId, id);
  if (!transfer) return null;
  const [audit, rail, funding] = await Promise.all([
    db
      .select({ at: auditEvents.at, action: auditEvents.action, actor: auditEvents.actor, actorType: auditEvents.actorType, meta: auditEvents.meta })
      .from(auditEvents)
      .where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.subjectId, transfer.id), inArray(auditEvents.action, [...TIMELINE_AUDIT_ACTIONS])))
      // Newest first under the limit (a long trail never hides the latest events); the pure
      // timeline sorts ascending for display.
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(TIMELINE_LIMIT),
    db
      .select({ status: outbox.status, attempts: outbox.attempts, createdAt: outbox.createdAt })
      .from(outbox)
      .where(inArray(outbox.dedupeKey, RAIL_KEYS(transfer.id)))
      .orderBy(desc(outbox.createdAt))
      .limit(5),
    db
      .select({ eventType: fundingEvents.eventType, outcome: fundingEvents.outcome, eventId: fundingEvents.eventId, receivedAt: fundingEvents.receivedAt })
      .from(fundingEvents)
      .where(and(eq(fundingEvents.partnerId, partnerId), eq(fundingEvents.transferId, transfer.id)))
      .orderBy(desc(fundingEvents.receivedAt))
      .limit(FUNDING_EVENTS_LIMIT),
  ]);
  return { transfer, audit, rail, fundingEvents: funding };
}
