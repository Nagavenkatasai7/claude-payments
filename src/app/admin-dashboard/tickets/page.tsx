export const dynamic = 'force-dynamic';

import { requireSupportOrAdmin } from '@/lib/auth';
import { Sidebar } from '../sidebar';
import { TicketQueueView, type QueueParams } from './queue-view';

// The support ticket queue (B3). requireSupportOrAdmin is THE gate — support
// staff land here (requireScope bounces them off every money page); admins
// share the surface. Partner-scoped staff are pinned to their tenant inside
// TicketQueueView; platform staff see all partners + a Partner column.

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<QueueParams>;
}) {
  const { staff, scope } = await requireSupportOrAdmin();
  const params = await searchParams;

  return (
    <>
      <Sidebar active="tickets" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Tickets</div>
            <div className="sh-page-sub">
              Customer support queue · newest activity first
            </div>
          </div>
        </div>
        <TicketQueueView
          staff={staff}
          scope={scope}
          basePath="/admin-dashboard/tickets"
          params={params}
        />
      </main>
    </>
  );
}
