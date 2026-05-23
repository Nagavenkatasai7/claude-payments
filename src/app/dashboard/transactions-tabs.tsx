'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Transfer } from '@/lib/types';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_payment', label: 'Awaiting' },
  { key: 'paid', label: 'Paid' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'blocked', label: 'Blocked' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function TransactionsTabs({
  transfers,
  renderRow,
}: {
  transfers: Transfer[];
  renderRow: (t: Transfer) => ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>('all');
  const visible =
    tab === 'all' ? transfers : transfers.filter((t) => t.status === tab);

  return (
    <>
      <div className="sh-card-head">
        <div>
          <div className="sh-card-title">Transactions</div>
          <div className="sh-card-sub">
            {visible.length} of {transfers.length} transfers
          </div>
        </div>
        <div className="sh-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`sh-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sh-ledger-wrap">
        {visible.length === 0 ? (
          <div className="sh-empty">No transactions in this view.</div>
        ) : (
          <table className="sh-table">
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Amount</th>
                <th>Funding</th>
                <th>US Payment</th>
                <th>India Delivery</th>
                <th>Compliance</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>{visible.map((t) => renderRow(t))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
