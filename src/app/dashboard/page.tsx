export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { summarize, isAbandoned } from '@/lib/dashboard';
import type { Transfer } from '@/lib/types';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from './actions';
import { LiveRefresh } from './live-refresh';

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function inr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}

function humanizeFunding(method: Transfer['fundingMethod']): string {
  switch (method) {
    case 'credit_card':
      return 'Credit card';
    case 'debit_card':
      return 'Debit card';
    case 'bank_transfer':
      return 'Bank transfer';
    default:
      return method;
  }
}

function StatusBadge({ status }: { status: Transfer['status'] }) {
  return <span className={`status-badge status-${status}`}>{status.replace('_', ' ')}</span>;
}

function AssignForm({ id }: { id: string }) {
  return (
    <form action={assignTransferAction} className="assign-form">
      <input type="hidden" name="id" value={id} />
      <input type="text" name="assignee" placeholder="Assignee" className="small-input" />
      <input type="text" name="note" placeholder="Note" className="small-input" />
      <button type="submit" className="action-btn assign-btn">Assign</button>
    </form>
  );
}

function TransferActions({ transfer }: { transfer: Transfer }) {
  const { status, id } = transfer;

  if (status === 'awaiting_payment') {
    return (
      <div className="action-group">
        <form action={resendPaymentLinkAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="action-btn resend-btn">Resend link</button>
        </form>
        <form action={cancelTransferAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="action-btn cancel-btn">Cancel</button>
        </form>
        <AssignForm id={id} />
      </div>
    );
  }

  if (status === 'paid') {
    return (
      <div className="action-group">
        <form action={cancelTransferAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="action-btn cancel-btn">Cancel/refund</button>
        </form>
        <AssignForm id={id} />
      </div>
    );
  }

  // delivered or cancelled
  return <AssignForm id={id} />;
}

export default async function DashboardPage() {
  const store = getStore();
  const transfers = await store.listTransfers();
  const now = Date.now();
  const summary = summarize(transfers, now);

  const abandoned = transfers.filter((t) => isAbandoned(t, now));

  return (
    <main className="dashboard">
      <h1 className="dashboard-title">SendHome Admin <LiveRefresh /></h1>

      {/* Summary Cards */}
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
      </section>

      {/* Needs Attention Panel */}
      <section className="attention">
        <h2>Needs Attention</h2>
        {abandoned.length === 0 ? (
          <p className="nothing-attention">Nothing needs attention right now.</p>
        ) : (
          <ul className="attention-list">
            {abandoned.map((t) => (
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

      {/* Transactions Ledger */}
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
                  <th>Status</th>
                  <th>US Payment</th>
                  <th>India Delivery</th>
                  <th>Assignee</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id} className={isAbandoned(t, now) ? 'row-abandoned' : ''}>
                    <td>{new Date(t.createdAt).toLocaleString()}</td>
                    <td>{t.recipientName}</td>
                    <td>{usd(t.amountUsd)}</td>
                    <td>{inr(t.amountInr)}</td>
                    <td>{usd(t.feeUsd)}</td>
                    <td>{humanizeFunding(t.fundingMethod)}</td>
                    <td>{t.payoutMethod.toUpperCase()}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td>
                      {t.paidAt ? (
                        <span className="stage-done">✓ {new Date(t.paidAt).toLocaleString()}</span>
                      ) : (
                        <span className="stage-pending">pending</span>
                      )}
                    </td>
                    <td>
                      {t.deliveredAt ? (
                        <span className="stage-done">✓ {new Date(t.deliveredAt).toLocaleString()}</span>
                      ) : t.status === 'paid' ? (
                        <span className="stage-pending">in transit</span>
                      ) : (
                        <span className="stage-pending">—</span>
                      )}
                    </td>
                    <td>{t.assignedTo ?? '—'}</td>
                    <td><TransferActions transfer={t} /></td>
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
