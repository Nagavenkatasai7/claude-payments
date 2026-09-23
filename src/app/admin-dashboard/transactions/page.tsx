export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getAuthStore } from '@/lib/auth-store';
import { toStaffOptions } from '@/lib/staff-options';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { senderNameKey } from '@/lib/sender-names';
import { hasPermission } from '@/lib/permissions';
import { deriveTier } from '@/lib/tier-rules';
import { sendGateActive } from '@/lib/kyc-gate';
import { Sidebar } from '../sidebar';
import { TransactionsExplorer } from '../transactions-explorer';
import type { KycInfo } from '../kyc-badge';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from '../actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Partner, Tier } from '@/lib/types';

// Stage 5b: SERVER keyset pagination — the page loads ONE window of the
// ledger (newest-first) instead of every transfer ever, and the tier/KYC
// badge maps are built from indexed per-phone reads for just the rows shown.
// Search and the date filter operate within the loaded window; "Older"
// follows the cursor.

const PAGE_SIZE = 100;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string; partner?: string; cursor?: string }>;
}) {
  const { staff: viewer } = await requireScope();
  const scoped = createScopedStore(viewer);
  const params = await searchParams;
  const initialSearch = params.phone ?? '';
  const partnerFilter = String(params.partner ?? '');
  const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : undefined;

  const [page, allStaff, partners] = await Promise.all([
    scoped.transfersPage({ limit: PAGE_SIZE, cursor, partnerFilter }),
    getAuthStore().listStaff(),
    scoped.listPartners(),
  ]);
  const transfers = page.items;

  const partnerById: Record<string, Partner> = {};
  for (const p of partners) partnerById[p.id] = p;

  // Badge maps for ONLY the senders on this page (indexed PK reads), keyed by
  // (tenant, phone) — the transfer's own tenant, so a row never borrows another
  // tenant's KYC/tier/name (fix 1). Tier display is gate-aware: where the owning
  // partner doesn't require KYC, an unverified customer is T1, not Suspended.
  // Sender legal names reuse these reads (customer-repo decrypts fullName by
  // default) instead of a second resolveSenderNames lookup.
  const customerStore = getCustomerStore(getStore());
  const senderKeys = [...new Map(transfers.map((t) => [senderNameKey(t.partnerId, t.phone), t])).values()];
  const customers = (
    await Promise.all(senderKeys.map((t) => customerStore.getCustomer(t.partnerId, t.phone)))
  ).filter((c): c is NonNullable<typeof c> => c !== null);
  const now = new Date();
  const tierByPhone: Record<string, Tier> = {};
  const kycByPhone: Record<string, KycInfo> = {};
  const senderNames: Record<string, string> = {};
  for (const c of customers) {
    const k = senderNameKey(c.partnerId, c.senderPhone);
    tierByPhone[k] = deriveTier(c, now, sendGateActive(partnerById[c.partnerId]));
    kycByPhone[k] = {
      kycStatus: c.kycStatus,
      kycReviewState: c.kycReviewState,
      watchlistHit: c.watchlistHit,
      pepHit: c.pepHit,
    };
    if (c.fullName) senderNames[k] = c.fullName;
  }

  // Pager hrefs preserve the partner filter (search/phone are window-local).
  const olderHref = page.nextCursor
    ? `/admin-dashboard/transactions?${new URLSearchParams({
        ...(partnerFilter ? { partner: partnerFilter } : {}),
        cursor: page.nextCursor,
      }).toString()}`
    : null;
  const newestHref = `/admin-dashboard/transactions${partnerFilter ? `?partner=${encodeURIComponent(partnerFilter)}` : ''}`;

  return (
    <>
      <Sidebar active="transactions" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Transactions</div>
            <div className="sh-page-sub">
              Newest first · {PAGE_SIZE} per page{cursor ? ' · paged view' : ''}
            </div>
          </div>
        </div>
        <Card className="overflow-hidden py-0">
          <TransactionsExplorer
            transfers={transfers}
            staff={toStaffOptions(allStaff)}
            staffByUsername={Object.fromEntries(
              allStaff.map((s) => [s.username, s.name]),
            )}
            tierByPhone={tierByPhone}
            kycByPhone={kycByPhone}
            senderNames={senderNames}
            partnerById={partnerById}
            currentPartner={partnerFilter}
            canCancel={hasPermission(viewer, 'canCancel')}
            canResend={hasPermission(viewer, 'canResend')}
            canAssign={hasPermission(viewer, 'canAssign')}
            cancelAction={cancelTransferAction}
            assignAction={assignTransferAction}
            resendAction={resendPaymentLinkAction}
            initialSearch={initialSearch}
          />
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              {transfers.length} {transfers.length === 1 ? 'transfer' : 'transfers'} in view
            </span>
            <div className="flex gap-2">
              {cursor && (
                <Button asChild variant="outline" size="sm">
                  <Link href={newestHref}>← Newest</Link>
                </Button>
              )}
              {olderHref && (
                <Button asChild variant="outline" size="sm">
                  <Link href={olderHref}>Older →</Link>
                </Button>
              )}
            </div>
          </div>
        </Card>
      </main>
    </>
  );
}
