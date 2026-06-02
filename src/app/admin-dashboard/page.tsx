export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import {
  summarize,
  needsAttention,
  schedulesDueInRange,
} from '@/lib/dashboard';
import type { Schedule, Transfer } from '@/lib/types';
import { money } from './format';
import { Sidebar } from './sidebar';

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
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

function statusPillClass(status: Transfer['status']): string {
  if (status === 'delivered') return 'sh-pill-success';
  if (status === 'paid') return 'sh-pill-info';
  if (status === 'awaiting_payment') return 'sh-pill-neutral';
  if (status === 'cancelled') return 'sh-pill-warning';
  return 'sh-pill-danger';
}

export default async function DashboardPage() {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  const transfers = await scoped.listTransfers();
  const schedules = await scoped.listSchedules();
  const now = Date.now();
  const summary = summarize(transfers, now);
  const attentionCount = transfers.filter((t) => needsAttention(t, now)).length;
  const recent = transfers.slice(0, 5);
  const nextDue = schedulesDueInRange(
    schedules.filter((s) => s.status === 'active'),
    now,
    365,
  ).slice(0, 3);
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

        <section
          className="sh-metrics"
          style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}
        >
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
        </section>

        {attentionCount > 0 && (
          <section className="sh-attention" style={{ marginBottom: 24 }}>
            <div className="sh-attention-title" style={{ alignItems: 'center' }}>
              ⚠ {attentionCount}{' '}
              {attentionCount === 1
                ? 'transfer needs'
                : 'transfers need'}{' '}
              attention
              <a
                href="/admin-dashboard/compliance"
                className="sh-recipient-sub"
                style={{ marginLeft: 'auto' }}
              >
                View on Compliance →
              </a>
            </div>
          </section>
        )}

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Recent transactions</div>
              <div className="sh-card-sub">Last 5</div>
            </div>
            <a href="/admin-dashboard/transactions" className="sh-btn-secondary">
              View all →
            </a>
          </div>
          <div className="sh-ledger-wrap">
            {recent.length === 0 ? (
              <div className="sh-empty">No transactions yet.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Amount</th>
                    <th>Funding</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="sh-recipient">{t.recipientName}</div>
                      </td>
                      <td>
                        <div className="sh-amount">{money(t.amountSource, t.sourceCurrency)}</div>
                        {t.sourceCurrency !== 'USD' && (
                          <div className="sh-recipient-sub">≈ {money(t.amountUsd, 'USD')}</div>
                        )}
                        <div className="sh-recipient-sub">
                          → {money(t.amountInr, t.destinationCurrency ?? 'INR')}
                        </div>
                      </td>
                      <td>{humanizeFunding(t.fundingMethod)}</td>
                      <td>
                        <span className={`sh-pill ${statusPillClass(t.status)}`}>
                          <span className="sh-pill-dot"></span>
                          {t.status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Next due schedules</div>
              <div className="sh-card-sub">Next 3</div>
            </div>
            <a href="/admin-dashboard/schedules" className="sh-btn-secondary">
              View all →
            </a>
          </div>
          <div className="sh-ledger-wrap">
            {nextDue.length === 0 ? (
              <div className="sh-empty">No schedules due soon.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr><th>Recipient</th><th>Amount</th><th>When</th></tr>
                </thead>
                <tbody>
                  {nextDue.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <div className="sh-recipient">{s.recipientName}</div>
                      </td>
                      <td className="sh-amount">{money(s.amountSource, s.sourceCurrency)}</td>
                      <td>{scheduleWhen(s)}</td>
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
