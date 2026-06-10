export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { schedulesDueInRange } from '@/lib/dashboard';
import { Sidebar } from '../sidebar';
import { Icon } from '../icons';
import { money } from '../format';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Schedule } from '@/lib/types';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

const SCHEDULE_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'When' },
  { label: 'Last run' },
  { label: 'Status', primary: true },
];

function scheduleWhen(s: Schedule): string {
  if (s.frequency === 'monthly') return `Monthly · day ${s.dayOfMonth}`;
  return `Weekly · ${WEEKDAYS[s.dayOfWeek ?? 0]}`;
}

export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  const params = await searchParams;
  const showAll = params.show === 'all';
  const all = await scoped.listSchedules();
  const visible = showAll ? all : all.filter((s) => s.status === 'active');
  const now = Date.now();
  const dueIn7 = schedulesDueInRange(
    all.filter((s) => s.status === 'active'),
    now,
    7,
  );

  return (
    <>
      <Sidebar active="schedules" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Schedules</div>
            <div className="sh-page-sub">Recurring transfers</div>
          </div>
        </div>

        <Card className="mb-6 border-l-4 border-l-warning">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-warning">
              <Icon name="calendar" /> Due in the next 7 days
              <span className="text-xs font-normal text-muted-foreground">
                {dueIn7.length} {dueIn7.length === 1 ? 'schedule' : 'schedules'}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dueIn7.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                Nothing due in the next 7 days.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {dueIn7.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{s.recipientName}</div>
                      <div className="text-xs text-muted-foreground">
                        {money(s.amountSource, s.sourceCurrency)} · {scheduleWhen(s)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>All Schedules</CardTitle>
              <CardDescription>
                {visible.length} of {all.length}
                {' '}{all.length === 1 ? 'schedule' : 'schedules'}
              </CardDescription>
            </div>
            <div className="inline-flex items-center gap-1 rounded-md bg-muted p-1">
              <Button
                asChild
                size="sm"
                variant={!showAll ? 'secondary' : 'ghost'}
              >
                <a href="/admin-dashboard/schedules">Active</a>
              </Button>
              <Button
                asChild
                size="sm"
                variant={showAll ? 'secondary' : 'ghost'}
              >
                <a href="/admin-dashboard/schedules?show=all">All</a>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <ExpandableTable
              columns={SCHEDULE_COLUMNS}
              empty={<>No schedules.</>}
              rows={visible.map((s) => ({
                key: s.id,
                label: s.recipientName,
                cells: [
                  <div key="recipient" className="font-medium">{s.recipientName}</div>,
                  <span key="amount" className="font-medium tabular-nums">{money(s.amountSource, s.sourceCurrency)}</span>,
                  scheduleWhen(s),
                  s.lastRunAt
                    ? new Date(s.lastRunAt).toLocaleDateString()
                    : <span key="lastrun" className="text-xs text-muted-foreground">—</span>,
                  <Badge key="status" variant={s.status === 'active' ? 'secondary' : 'outline'}>
                    {s.status}
                  </Badge>,
                ],
              }))}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
