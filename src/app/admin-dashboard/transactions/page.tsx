export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getAuthStore } from '@/lib/auth-store';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { hasPermission } from '@/lib/permissions';
import { deriveTier } from '@/lib/tier-rules';
import { Sidebar } from '../sidebar';
import { TransactionsExplorer } from '../transactions-explorer';
import type { KycInfo } from '../kyc-badge';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from '../actions';
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

  // Badge maps for ONLY the phones on this page (indexed PK reads).
  const customerStore = getCustomerStore(getStore());
  const phones = [...new Set(transfers.map((t) => t.phone))];
  const customers = (
    await Promise.all(phones.map((p) => customerStore.getCustomer(p)))
  ).filter((c): c is NonNullable<typeof c> => c !== null);
  const now = new Date();
  const tierByPhone: Record<string, Tier> = {};
  const kycByPhone: Record<string, KycInfo> = {};
  for (const c of customers) {
    tierByPhone[c.senderPhone] = deriveTier(c, now);
    kycByPhone[c.senderPhone] = {
      kycStatus: c.kycStatus,
      kycReviewState: c.kycReviewState,
      watchlistHit: c.watchlistHit,
      pepHit: c.pepHit,
    };
  }

  const partnerById: Record<string, Partner> = {};
  for (const p of partners) partnerById[p.id] = p;

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
        <section className="sh-card">
          <TransactionsExplorer
            transfers={transfers}
            staff={allStaff}
            staffByUsername={Object.fromEntries(
              allStaff.map((s) => [s.username, s.name]),
            )}
            tierByPhone={tierByPhone}
            kycByPhone={kycByPhone}
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
                <Link href={newestHref} className="sh-btn-secondary">
                  ← Newest
                </Link>
              )}
              {olderHref && (
                <Link href={olderHref} className="sh-btn-secondary">
                  Older →
                </Link>
              )}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
