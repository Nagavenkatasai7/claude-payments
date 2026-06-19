export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getAuthStore } from '@/lib/auth-store';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
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

  // Badge maps for ONLY the phones on this page (indexed PK reads). Tier
  // display is gate-aware: where the owning partner doesn't require KYC, an
  // unverified customer is T1, not Suspended (matches enforcement).
  const customerStore = getCustomerStore(getStore());
  const phones = [...new Set(transfers.map((t) => t.phone))];
  const customers = (
    await Promise.all(phones.map((p) => customerStore.getCustomer(p)))
  ).filter((c): c is NonNullable<typeof c> => c !== null);
  const now = new Date();
  const tierByPhone: Record<string, Tier> = {};
  const kycByPhone: Record<string, KycInfo> = {};
  // Sender legal names for the list — the customer reads above already decrypt
  // fullName (customer-repo defaults to decrypted PII), so we reuse them here
  // instead of a second resolveSenderNames lookup. Absent name ⇒ omitted ⇒
  // SenderCell falls back to the phone.
  const senderNames: Record<string, string> = {};
  for (const c of customers) {
    tierByPhone[c.senderPhone] = deriveTier(c, now, sendGateActive(partnerById[c.partnerId]));
    kycByPhone[c.senderPhone] = {
      kycStatus: c.kycStatus,
      kycReviewState: c.kycReviewState,
      watchlistHit: c.watchlistHit,
      pepHit: c.pepHit,
    };
    if (c.fullName) senderNames[c.senderPhone] = c.fullName;
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
            staff={allStaff}
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
