export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { getCustomerStore } from '@/lib/customer-store';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { deriveTier } from '@/lib/tier-rules';
import { Sidebar } from '../sidebar';
import { TransactionsExplorer } from '../transactions-explorer';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from '../actions';
import type { Tier } from '@/lib/types';

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  const viewer = await requireStaff();
  const store = getStore();
  const customerStore = getCustomerStore(store);
  const [transfers, staff, customers] = await Promise.all([
    store.listTransfers(),
    getAuthStore().listStaff(),
    customerStore.listCustomers(),
  ]);
  const now = new Date();
  const tierByPhone: Record<string, Tier> = {};
  for (const c of customers) tierByPhone[c.senderPhone] = deriveTier(c, now);
  const params = await searchParams;
  const initialSearch = params.phone ?? '';

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
            transfers={transfers}
            staff={staff}
            staffByUsername={Object.fromEntries(
              staff.map((s) => [s.username, s.name]),
            )}
            tierByPhone={tierByPhone}
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
