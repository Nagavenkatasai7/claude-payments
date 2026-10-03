import type { DbOrTx } from '@/db/client';
import { createB2bInvoiceRepo } from './aux-repos';
import type { B2bInvoice, PartnerId } from '@/lib/types';

// partner-invoice-reads (lost-features A6): the /partner/invoices list. The partner id comes FIRST
// and is REQUIRED (the page passes the SESSION tenant); it is in the SQL WHERE, and the page size is
// bounded. The caller masks every row (partner-invoices.ts invoiceRow).

export const INVOICE_PAGE_LIMIT = 100;

function requireTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('partner-invoice-reads: a tenant is required');
}

/** THIS tenant's newest invoices, at most `limit` (1..INVOICE_PAGE_LIMIT). */
export async function listPartnerInvoices(
  db: DbOrTx,
  partnerId: PartnerId,
  opts: { limit?: number } = {},
): Promise<B2bInvoice[]> {
  requireTenant(partnerId);
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? INVOICE_PAGE_LIMIT) || 1), INVOICE_PAGE_LIMIT);
  const rows = await createB2bInvoiceRepo(db).listRecentInvoices(partnerId, limit);
  // Defence in depth: the WHERE already pins the tenant.
  return rows.filter((r) => r.partnerId === partnerId);
}
