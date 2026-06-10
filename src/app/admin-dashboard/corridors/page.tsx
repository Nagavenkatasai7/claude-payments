export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

const CORRIDOR_COLUMNS: ExpandableColumn[] = [
  { label: 'Date' },
  { label: 'Destination', primary: true },
  { label: 'Approx amount', primary: true },
  { label: 'Sender phone' },
];

export default async function CorridorsPage() {
  // Corridor requests are platform-wide (no per-partner scoping yet).
  // Require any authenticated staff; render nothing sensitive if partner-scoped.
  await requireScope();

  const requests = await getStore().listCorridorRequests();

  return (
    <>
      <Sidebar active="corridors" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Corridor requests</div>
            <div className="sh-page-sub">
              Customers who asked to send to countries we don&apos;t deliver to yet.
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All requests</CardTitle>
            <CardDescription>
              {requests.length} {requests.length === 1 ? 'request' : 'requests'}, newest first
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={CORRIDOR_COLUMNS}
              empty={<>No corridor requests yet.</>}
              rows={requests.map((r) => ({
                key: r.id,
                label: r.destinationCountry,
                cells: [
                  new Date(r.capturedAt).toLocaleString(),
                  r.destinationCountry,
                  r.approxAmount != null ? (
                    money(r.approxAmount, r.approxCurrency ?? 'USD')
                  ) : (
                    <span key="amount" className="text-xs text-muted-foreground">—</span>
                  ),
                  <span key="phone" className="text-xs text-muted-foreground">+{r.senderPhone}</span>,
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
