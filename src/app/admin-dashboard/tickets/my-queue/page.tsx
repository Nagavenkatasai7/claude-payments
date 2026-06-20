export const dynamic = 'force-dynamic';

import { requireTicketWorker } from '@/lib/auth';
import { Sidebar } from '../../sidebar';
import { TicketQueueView, type QueueParams } from '../queue-view';

// My queue — the same scoped customer-ticket list, pinned to
// assignedTo = the signed-in staff member. Agents live HERE: it's the only
// ticket surface they get (the global queue redirects them back), showing
// exactly the tickets the load balancer assigned them.

export default async function MyQueuePage({
  searchParams,
}: {
  searchParams: Promise<QueueParams>;
}) {
  const { staff, scope } = await requireTicketWorker();
  const params = await searchParams;

  return (
    <>
      <Sidebar active="my-queue" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">My queue</div>
            <div className="sh-page-sub">
              Tickets assigned to {staff.name}
            </div>
          </div>
        </div>
        <TicketQueueView
          staff={staff}
          scope={scope}
          basePath="/admin-dashboard/tickets/my-queue"
          params={params}
          pinAssignee={staff.username}
        />
      </main>
    </>
  );
}
