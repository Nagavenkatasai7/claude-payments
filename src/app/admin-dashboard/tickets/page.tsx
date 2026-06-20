export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { requireTicketWorker } from '@/lib/auth';
import { Sidebar } from '../sidebar';
import { TicketQueueView, type QueueParams } from './queue-view';

// The support ticket QUEUE (B3) — support staff land here (requireScope bounces
// them off every money page); admins share the surface. Agents are ticket
// handlers too, but only of THEIR assigned tickets, so they're bounced to their
// personal My queue (they never browse the whole tenant). Partner-scoped staff
// are pinned to their tenant inside TicketQueueView.

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<QueueParams>;
}) {
  const { staff, scope } = await requireTicketWorker();
  if (staff.role === 'agent') redirect('/admin-dashboard/tickets/my-queue');
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
