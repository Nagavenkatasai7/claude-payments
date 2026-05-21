export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { summarize, needsAttention } from '@/lib/dashboard';
import { logout } from '../login/actions';
import { LiveRefresh } from './live-refresh';
import type { Staff, Transfer } from '@/lib/types';

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

function StatusBadge({ status }: { status: Transfer['status'] }) {
  return (
    <span className={`status-badge status-${status}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function Stage({ at, fallback }: { at?: string; fallback: string }) {
  if (at) {
    return (
      <span className="stage-done">✓ {new Date(at).toLocaleString()}</span>
    );
  }
  return <span className="stage-pending">{fallback}</span>;
}

function AssignForm({ id, staff }: { id: string; staff: Staff[] }) {
  return (
    <form action={assignTransferAction} className="assign-form">
      <input type="hidden" name="id" value={id} />
      <select name="assignee" className="small-input" required>
        <option value="">Assign to…</option>
        {staff.map((s) => (
          <option key={s.username} value={s.username}>
            {s.name}
          </option>
        ))}
      </select>
      <input type="text" name="note" placeholder="Note" className="small-input" />
      <button type="submit" className="action-btn assign-btn">
        Assign
      </button>
    </form>
  );
}

import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from './actions';

function TransferActions({
  transfer,
  viewer,
  staff,
}: {
  transfer: Transfer;
  viewer: Staff;
  staff: Staff[];
}) {
  const { status, id } = transfer;
  const canCancel = hasPermission(viewer, 'canCancel');
  const canResend = hasPermission(viewer, 'canResend');
  const canAssign = hasPermission(viewer, 'canAssign');

  return (
    <div className="action-group">
      {status === 'awaiting_payment' && canResend && (
        <form action={resendPaymentLinkAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="action-btn resend-btn">
            Resend link
          </button>
        </form>
      )}
      {(status === 'awaiting_payment' || status === 'paid') && canCancel && (
        <form action={cancelTransferAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="action-btn cancel-btn">
            Cancel/refund
          </button>
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
  const now = Date.now();
  const summary = summarize(transfers, now);
  const attentionTransfers = transfers.filter((t) => needsAttention(t, now));
  const staffByUsername = new Map(staff.map((s) => [s.username, s.name]));

  return (
    <main className="dashboard">
      <header className="dash-header">
        <h1 className="dashboard-title">SendHome Admin</h1>
        <div className="dash-header-right">
          <LiveRefresh />
          <span className="who">
            {viewer.name} ({viewer.role})
          </span>
          {viewer.role === 'admin' && (
            <a href="/dashboard/team" className="action-btn">
              Team &amp; Permissions
            </a>
          )}
          <form action={logout}>
            <button type="submit" className="action-btn">
              Log out
            </button>
          </form>
        </div>
      </header>

      <section className="cards">
        <div className="metric">
          <span className="metric-label">Commission today</span>
          <span className="metric-value">{usd(summary.commissionToday)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Volume today</span>
          <span className="metric-value">{usd(summary.volumeToday)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Transactions today</span>
          <span className="metric-value">{summary.countToday}</span>
        </div>
        <div className="metric metric-attention">
          <span className="metric-label">Needs attention</span>
          <span className="metric-value">{summary.needsAttention}</span>
        </div>
        <div className="metric metric-small">
          <span className="metric-label">All-time commission</span>
          <span className="metric-value">{usd(summary.commissionAllTime)}</span>
        </div>
        <div className="metric metric-small">
          <span className="metric-label">Flagged today</span>
          <span className="metric-value">{summary.flaggedToday}</span>
        </div>
      </section>

      <section className="attention">
        <h2>Needs Attention</h2>
        {attentionTransfers.length === 0 ? (
          <p className="nothing-attention">Nothing needs attention right now.</p>
        ) : (
          <ul className="attention-list">
            {attentionTransfers.map((t) => (
              <li key={t.id} className="attention-item">
                <span className="attention-id">{t.id}</span>
                <span className="attention-name">{t.recipientName}</span>
                <span className="attention-amount">{usd(t.amountUsd)}</span>
                <span className="attention-age">
                  Created {new Date(t.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ledger-section">
        <h2>All Transactions</h2>
        {transfers.length === 0 ? (
          <p className="empty-state">No transactions yet.</p>
        ) : (
          <div className="ledger-wrapper">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>→ INR</th>
                  <th>Fee</th>
                  <th>Funding</th>
                  <th>Payout</th>
                  <th>Compliance</th>
                  <th>US Payment</th>
                  <th>India Delivery</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr
                    key={t.id}
                    className={needsAttention(t, now) ? 'row-abandoned' : ''}
                  >
                    <td>{new Date(t.createdAt).toLocaleString()}</td>
                    <td>{t.recipientName}</td>
                    <td>{usd(t.amountUsd)}</td>
                    <td>{inr(t.amountInr)}</td>
                    <td>{usd(t.feeUsd)}</td>
                    <td>{humanizeFunding(t.fundingMethod)}</td>
                    <td>{t.payoutMethod.toUpperCase()}</td>
                    <td>
                      <span className={`status-badge compliance-${t.complianceStatus}`}>{t.complianceStatus}</span>
                    </td>
                    <td>
                      <Stage at={t.paidAt} fallback="pending" />
                    </td>
                    <td>
                      <Stage
                        at={t.deliveredAt}
                        fallback={t.status === 'paid' ? 'in transit' : '—'}
                      />
                    </td>
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                    <td>
                      {t.assignedTo
                        ? staffByUsername.get(t.assignedTo) ?? t.assignedTo
                        : '—'}
                    </td>
                    <td>
                      <TransferActions
                        transfer={t}
                        viewer={viewer}
                        staff={staff}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
