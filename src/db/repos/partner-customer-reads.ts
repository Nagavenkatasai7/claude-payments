import { and, eq, max, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { transfers } from '@/db/schema';
import { createTransferRepo, type Page } from './transfer-repo';
import type { PartnerId, Transfer } from '@/lib/types';

// partner-customer-reads (lost-features p2 A10, B4): the /partner customer pages' LEDGER reads.
// Read-only and masked (never a decrypting read, no encrypted column selected). Every function takes
// the partner id FIRST and REQUIRED: the pages pass the SESSION tenant, never request input. Live
// rows only (sandbox volume is not business). Kept apart from partner-transfer-reads (the transfer
// pages' file) so the two builds never edit the same reader.

const MAX_PAGE = 50;

function requireTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('partner-customer-reads: a tenant is required');
}

export interface CustomerTotals {
  /** Live transfers, cancelled and blocked excluded. */
  count: number;
  /** Paid and delivered live transfers, in USD cents (the portal's "sent" rule, customer-stats sentUsd). */
  sentCents: number;
  /** The newest live transfer of any status (ISO). */
  lastAt: string;
}

/** Per-phone ledger totals for THIS tenant's live transfers: one grouped query, keyed by phone. */
export async function partnerCustomerTotals(db: DbOrTx, partnerId: PartnerId): Promise<Map<string, CustomerTotals>> {
  requireTenant(partnerId);
  const rows = await db
    .select({
      phone: transfers.phone,
      count: sql<number>`count(*) FILTER (WHERE ${transfers.status} NOT IN ('cancelled','blocked'))::int`,
      sentCents: sql<number>`coalesce(round(sum(${transfers.amountUsd}) FILTER (WHERE ${transfers.status} IN ('paid','delivered')) * 100), 0)::bigint`,
      lastAt: max(transfers.createdAt),
    })
    .from(transfers)
    .where(and(eq(transfers.partnerId, partnerId), eq(transfers.environment, 'live')))
    .groupBy(transfers.phone);
  const out = new Map<string, CustomerTotals>();
  for (const r of rows) {
    if (!r.lastAt) continue;
    out.set(r.phone, { count: Number(r.count), sentCents: Number(r.sentCents), lastAt: new Date(r.lastAt).toISOString() });
  }
  return out;
}

/** One keyset page of ONE customer's live transfers at THIS tenant, newest first (masked rows). */
export async function listPartnerCustomerTransfers(
  db: DbOrTx,
  partnerId: PartnerId,
  phone: string,
  req: { limit: number; cursor?: string },
): Promise<Page<Transfer>> {
  requireTenant(partnerId);
  if (typeof phone !== 'string' || phone.length === 0) throw new Error('partner-customer-reads: a phone is required');
  const limit = Math.min(Math.max(1, Math.trunc(req.limit) || 1), MAX_PAGE);
  const page = await createTransferRepo(db).listByPhone(partnerId, phone, { limit, cursor: req.cursor });
  // Defence in depth: the repo already has tenant AND phone in the WHERE.
  return { ...page, items: page.items.filter((t) => t.partnerId === partnerId && t.phone === phone) };
}
