export const dynamic = 'force-dynamic';

import { getAuthStore } from '@/lib/auth-store';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { hasPermission } from '@/lib/permissions';
import { deriveTier } from '@/lib/tier-rules';
import { Sidebar } from '../sidebar';
import { TransactionsExplorer } from '../transactions-explorer';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from '../actions';
import type { Partner, Tier } from '@/lib/types';

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string; partner?: string }>;
}) {
  const { staff: viewer } = await requireScope();
  const scoped = createScopedStore(viewer);
  const [transfers, allStaff, customers, partners] = await Promise.all([
    scoped.listTransfers(),
    getAuthStore().listStaff(),
    scoped.listCustomers(),
    scoped.listPartners(),
  ]);
  const now = new Date();
  const tierByPhone: Record<string, Tier> = {};
  for (const c of customers) tierByPhone[c.senderPhone] = deriveTier(c, now);

  const partnerById: Record<string, Partner> = {};
  for (const p of partners) partnerById[p.id] = p;

  const params = await searchParams;
  const initialSearch = params.phone ?? '';
  const partnerFilter = String(params.partner ?? '');
  const filteredTransfers = partnerFilter
    ? transfers.filter((t) => t.partnerId === partnerFilter)
    : transfers;

  return (
    <>
      <Sidebar active="transactions" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Transactions</div>
            <div className="sh-page-sub">All transfers, newest first</div>
          </div>
        </div>
        <section className="sh-card">
          <TransactionsExplorer
            transfers={filteredTransfers}
            staff={allStaff}
            staffByUsername={Object.fromEntries(
              allStaff.map((s) => [s.username, s.name]),
            )}
            tierByPhone={tierByPhone}
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
        </section>
      </main>
    </>
  );
}
