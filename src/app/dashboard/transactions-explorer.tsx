'use client';

import { useState } from 'react';
import type { Staff, Tier, Transfer } from '@/lib/types';
import { TransactionsTabs } from './transactions-tabs';

export interface TransactionsExplorerProps {
  transfers: Transfer[];
  staff: Staff[];
  staffByUsername: Record<string, string>;
  tierByPhone: Record<string, Tier>;
  canCancel: boolean;
  canResend: boolean;
  canAssign: boolean;
  cancelAction: (formData: FormData) => void | Promise<void>;
  assignAction: (formData: FormData) => void | Promise<void>;
  resendAction: (formData: FormData) => void | Promise<void>;
  initialSearch?: string;
}

export function TransactionsExplorer(props: TransactionsExplorerProps) {
  const [search, setSearch] = useState(props.initialSearch ?? '');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const q = search.trim().toLowerCase();
  const fromMs = fromDate ? Date.parse(fromDate) : null;
  const toMs = toDate ? Date.parse(toDate) + 86400000 : null; // include the end date

  const filtered = props.transfers.filter((t) => {
    if (q) {
      const hay = `${t.recipientName} ${t.payoutDestination} ${t.phone}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (fromMs !== null && Date.parse(t.createdAt) < fromMs) return false;
    if (toMs !== null && Date.parse(t.createdAt) >= toMs) return false;
    return true;
  });

  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '16px 20px',
          borderBottom: '1px solid var(--sh-border)',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Search recipient, destination, or sender phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sh-input"
          style={{ flex: 1, minWidth: 220 }}
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--sh-text-secondary)',
          }}
        >
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="sh-input"
          />
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--sh-text-secondary)',
          }}
        >
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="sh-input"
          />
        </label>
      </div>
      <TransactionsTabs
        transfers={filtered}
        staff={props.staff}
        staffByUsername={props.staffByUsername}
        tierByPhone={props.tierByPhone}
        canCancel={props.canCancel}
        canResend={props.canResend}
        canAssign={props.canAssign}
        cancelAction={props.cancelAction}
        assignAction={props.assignAction}
        resendAction={props.resendAction}
      />
    </>
  );
}
