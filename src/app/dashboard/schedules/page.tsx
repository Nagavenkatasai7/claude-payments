export const dynamic = 'force-dynamic';

import { getScheduleStore } from '@/lib/schedule-store';
import { requireStaff } from '@/lib/auth';
import { schedulesDueInRange } from '@/lib/dashboard';
import { Sidebar } from '../sidebar';
import type { Schedule } from '@/lib/types';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

function scheduleWhen(s: Schedule): string {
  if (s.frequency === 'monthly') return `Monthly · day ${s.dayOfMonth}`;
  return `Weekly · ${WEEKDAYS[s.dayOfWeek ?? 0]}`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  await requireStaff();
  const params = await searchParams;
  const showAll = params.show === 'all';
  const all = await getScheduleStore().listSchedules();
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
                    {usd(s.amountUsd)} · {scheduleWhen(s)}
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
                href="/dashboard/schedules"
                className={`sh-tab ${!showAll ? 'active' : ''}`}
              >
                Active
              </a>
              <a
                href="/dashboard/schedules?show=all"
                className={`sh-tab ${showAll ? 'active' : ''}`}
              >
                All
              </a>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {visible.length === 0 ? (
              <div className="sh-empty">No schedules.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Amount</th>
                    <th>When</th>
                    <th>Last run</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => (
                    <tr key={s.id}>
                      <td><div className="sh-recipient">{s.recipientName}</div></td>
                      <td className="sh-amount">{usd(s.amountUsd)}</td>
                      <td>{scheduleWhen(s)}</td>
                      <td>
                        {s.lastRunAt
                          ? new Date(s.lastRunAt).toLocaleDateString()
                          : <span className="sh-recipient-sub">—</span>}
                      </td>
                      <td>
                        <span className={`sh-pill ${
                          s.status === 'active' ? 'sh-pill-info' : 'sh-pill-neutral'
                        }`}>
                          <span className="sh-pill-dot"></span>{s.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
