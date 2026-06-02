export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { schedulesDueInRange } from '@/lib/dashboard';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import { ExpandableTable, type ExpandableColumn } from '../expandable-table';
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

        <section
          className="sh-attention"
          style={{ borderLeftColor: 'var(--sh-warning)' }}
        >
          <div
            className="sh-attention-title"
            style={{ color: 'var(--sh-warning)' }}
          >
            📅 Due in the next 7 days
            <span className="sh-attention-count">
              {dueIn7.length} {dueIn7.length === 1 ? 'schedule' : 'schedules'}
            </span>
          </div>
          {dueIn7.length === 0 ? (
            <div className="sh-attention-meta">
              Nothing due in the next 7 days.
            </div>
          ) : (
            dueIn7.map((s) => (
              <div key={s.id} className="sh-attention-row">
                <div className="sh-attention-info">
                  <div className="sh-attention-recipient">{s.recipientName}</div>
                  <div className="sh-attention-meta">
                    {money(s.amountSource, s.sourceCurrency)} · {scheduleWhen(s)}
                  </div>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">All Schedules</div>
              <div className="sh-card-sub">
                {visible.length} of {all.length}
                {' '}{all.length === 1 ? 'schedule' : 'schedules'}
              </div>
            </div>
            <div className="sh-tabs">
              <a
                href="/admin-dashboard/schedules"
                className={`sh-tab ${!showAll ? 'active' : ''}`}
              >
                Active
              </a>
              <a
                href="/admin-dashboard/schedules?show=all"
                className={`sh-tab ${showAll ? 'active' : ''}`}
              >
                All
              </a>
            </div>
          </div>
          <ExpandableTable
            columns={SCHEDULE_COLUMNS}
            empty={<>No schedules.</>}
            rows={visible.map((s) => ({
              key: s.id,
              label: s.recipientName,
              cells: [
                <div key="recipient" className="sh-recipient">{s.recipientName}</div>,
                <span key="amount" className="sh-amount">{money(s.amountSource, s.sourceCurrency)}</span>,
                scheduleWhen(s),
                s.lastRunAt
                  ? new Date(s.lastRunAt).toLocaleDateString()
                  : <span key="lastrun" className="sh-recipient-sub">—</span>,
                <span key="status" className={`sh-pill ${
                  s.status === 'active' ? 'sh-pill-info' : 'sh-pill-neutral'
                }`}>
                  <span className="sh-pill-dot"></span>{s.status}
                </span>,
              ],
            }))}
          />
        </section>
      </main>
    </>
  );
}
