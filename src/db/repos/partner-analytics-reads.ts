import type { DbOrTx } from '@/db/client';
import { createTransferRepo } from './transfer-repo';
import type { PartnerId, Transfer } from '@/lib/types';

// partner-analytics-reads (merge plan 2d): the /partner/analytics READ. Read-only and masked (the
// repo's default ledger read, never a decrypting one). The partner id is REQUIRED and goes into the
// SQL WHERE (adminList); the page passes the SESSION tenant, never request input. LIVE rows only,
// like the /partner home KPIs (sandbox volume is not business).

const PAGE = 500;
const DAY_MS = 86_400_000;

function requireTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('partner-analytics-reads: a tenant is required');
}

/**
 * THIS tenant's live transfers created in the last `days` days, newest first, at most `cap` rows
 * (keyset pages, stopping at the first page that reaches past the window). `truncated` is true
 * when the cap cut the window short.
 */
export async function listPartnerLiveTransfersSince(
  db: DbOrTx,
  partnerId: PartnerId,
  req: { now: number; days: number; cap: number },
): Promise<{ items: Transfer[]; truncated: boolean }> {
  requireTenant(partnerId);
  const cutoff = req.now - req.days * DAY_MS;
  const repo = createTransferRepo(db);
  const items: Transfer[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await repo.adminList({ limit: PAGE, cursor, partnerId, environment: 'live' });
    for (const t of page.items) {
      if (t.partnerId !== partnerId) continue; // Defence in depth: the WHERE already pins the tenant.
      if (Date.parse(t.createdAt) < cutoff) return { items, truncated: false };
      if (items.length >= req.cap) return { items, truncated: true };
      items.push(t);
    }
    if (!page.nextCursor) return { items, truncated: false };
    cursor = page.nextCursor;
  }
}
