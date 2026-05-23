export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { getScheduleStore } from '@/lib/schedule-store';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { summarize, needsAttention } from '@/lib/dashboard';
import type { Schedule, Staff, Transfer } from '@/lib/types';
import { Sidebar } from './sidebar';
import { TransactionsTabs } from './transactions-tabs';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from './actions';

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
function inr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}
function humanizeFunding(method: Transfer['fundingMethod']): string {
  if (method === 'credit_card') return 'Credit card';
  if (method === 'debit_card') return 'Debit card';
  return 'Bank transfer';
}

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

function scheduleWhen(s: Schedule): string {
  if (s.frequency === 'monthly') return `Monthly · day ${s.dayOfMonth}`;
  return `Weekly · ${WEEKDAYS[s.dayOfWeek ?? 0]}`;
}

function StatusPill({ status }: { status: Transfer['status'] }) {
  const klass =
    status === 'delivered' ? 'sh-pill-success' :
    status === 'paid' ? 'sh-pill-info' :
    status === 'awaiting_payment' ? 'sh-pill-neutral' :
    status === 'cancelled' ? 'sh-pill-warning' :
    'sh-pill-danger';
  return (
    <span className={`sh-pill ${klass}`}>
      <span className="sh-pill-dot"></span>{status.replace('_', ' ')}
    </span>
  );
}

function ComplianceBadge({ status }: { status: Transfer['complianceStatus'] }) {
  const klass =
    status === 'cleared' ? 'sh-pill-success' :
    status === 'flagged' ? 'sh-pill-warning' :
    'sh-pill-danger';
  return (
    <span className={`sh-pill ${klass}`}>
      <span className="sh-pill-dot"></span>{status}
    </span>
  );
}

function Stage({ at, fallback }: { at?: string; fallback: string }) {
  if (at) {
    return (
      <span className="sh-stage">
        <span className="sh-check">✓</span>
        {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    );
  }
  return <span className="sh-stage-pending">{fallback}</span>;
}

function AssignForm({ id, staff }: { id: string; staff: Staff[] }) {
  return (
    <form action={assignTransferAction} className="sh-inline-form">
      <input type="hidden" name="id" value={id} />
      <select name="assignee" className="sh-inline-select" required>
        <option value="">Assign…</option>
        {staff.map((s) => (
          <option key={s.username} value={s.username}>{s.name}</option>
        ))}
      </select>
      <input type="text" name="note" placeholder="Note" className="sh-inline-input" />
      <button type="submit" className="sh-mini-btn">Save</button>
    </form>
  );
}

function RowActions({
  transfer, viewer, staff,
}: { transfer: Transfer; viewer: Staff; staff: Staff[] }) {
  const { status, id } = transfer;
  const canCancel = hasPermission(viewer, 'canCancel');
  const canResend = hasPermission(viewer, 'canResend');
  const canAssign = hasPermission(viewer, 'canAssign');

  return (
    <div className="sh-attention-actions">
      {status === 'awaiting_payment' && canResend && (
        <form action={resendPaymentLinkAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="sh-mini-btn">Resend link</button>
        </form>
      )}
      {(status === 'awaiting_payment' || status === 'paid') && canCancel && (
        <form action={cancelTransferAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Cancel</button>
        </form>
      )}
      {canAssign && <AssignForm id={id} staff={staff} />}
    </div>
  );
}

export default async function DashboardPage() {
  const viewer = await requireStaff();
  const transfers = await getStore().listTransfers();
  const staff = await getAuthStore().listStaff();
  const schedules = await getScheduleStore().listSchedules();
  const now = Date.now();
  const summary = summarize(transfers, now);
  const attention = transfers.filter((t) => needsAttention(t, now));
  const staffByUsername = new Map(staff.map((s) => [s.username, s.name]));
  const todayLabel = new Date(now).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <>
      <Sidebar active="overview" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Overview</div>
            <div className="sh-page-sub">{todayLabel}</div>
          </div>
        </div>

        <section className="sh-metrics">
          <div className="sh-metric sh-metric-primary">
            <div className="sh-metric-label">Commission today</div>
            <div className="sh-metric-value">{usd(summary.commissionToday)}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Volume today</div>
            <div className="sh-metric-value">{usd(summary.volumeToday)}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Transactions today</div>
            <div className="sh-metric-value">{summary.countToday}</div>
          </div>
          <div className="sh-metric sh-metric-alert">
            <div className="sh-metric-label">Flagged today</div>
            <div className="sh-metric-value">{summary.flaggedToday}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">All-time commission</div>
            <div className="sh-metric-value">{usd(summary.commissionAllTime)}</div>
            <div className="sh-metric-sub">Across {transfers.length} transfers</div>
          </div>
        </section>

        <section id="attention" className="sh-attention">
          <div className="sh-attention-title">
            ⚠ Needs Attention
            <span className="sh-attention-count">{attention.length} items</span>
          </div>
          {attention.length === 0 ? (
            <div className="sh-attention-meta">Nothing needs attention right now.</div>
          ) : (
            attention.map((t) => (
              <div key={t.id} className="sh-attention-row">
                <div className="sh-attention-info">
                  <div className="sh-attention-recipient">
                    {t.recipientName}
                    {t.complianceStatus !== 'cleared' && ` — ${t.complianceStatus}`}
                  </div>
                  <div className="sh-attention-meta">
                    {usd(t.amountUsd)} · {t.payoutMethod.toUpperCase()} ·{' '}
                    {t.complianceReasons.length > 0
                      ? t.complianceReasons.join(' · ')
                      : `awaiting payment since ${new Date(t.createdAt).toLocaleString()}`}
                  </div>
                </div>
                <RowActions transfer={t} viewer={viewer} staff={staff} />
              </div>
            ))
          )}
        </section>

        <section id="transactions" className="sh-card">
          <TransactionsTabs
            transfers={transfers}
            renderRow={(t) => (
              <tr key={t.id}>
                <td>
                  <div className="sh-recipient">{t.recipientName}</div>
                  <div className="sh-recipient-sub">
                    {t.payoutMethod.toUpperCase()} · {t.payoutDestination}
                  </div>
                </td>
                <td>
                  <div className="sh-amount">{usd(t.amountUsd)}</div>
                  <div className="sh-recipient-sub">{inr(t.amountInr)}</div>
                </td>
                <td>{humanizeFunding(t.fundingMethod)}</td>
                <td><Stage at={t.paidAt} fallback="pending" /></td>
                <td>
                  <Stage
                    at={t.deliveredAt}
                    fallback={t.status === 'paid' ? 'in transit' : '—'}
                  />
                </td>
                <td><ComplianceBadge status={t.complianceStatus} /></td>
                <td><StatusPill status={t.status} /></td>
                <td>
                  {t.assignedTo
                    ? staffByUsername.get(t.assignedTo) ?? t.assignedTo
                    : <span className="sh-recipient-sub">—</span>}
                </td>
                <td><RowActions transfer={t} viewer={viewer} staff={staff} /></td>
              </tr>
            )}
          />
        </section>

        <section id="schedules" className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Recurring Schedules</div>
              <div className="sh-card-sub">
                {schedules.filter((s) => s.status === 'active').length} active
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {schedules.length === 0 ? (
              <div className="sh-empty">No recurring schedules yet.</div>
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
                  {schedules.map((s) => (
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
