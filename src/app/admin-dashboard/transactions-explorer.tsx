'use client';

import { useState } from 'react';
import type { Partner, Staff, Tier, Transfer } from '@/lib/types';
import { accountLast4 } from '@/lib/payout-format';
import { TransactionsTabs } from './transactions-tabs';
import { Icon } from './icons';

export interface TransactionsExplorerProps {
  transfers: Transfer[];
  staff: Staff[];
  staffByUsername: Record<string, string>;
  tierByPhone: Record<string, Tier>;
  partnerById: Record<string, Partner>;
  currentPartner: string;
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
      // Search matches the account's LAST-4 only (not the full number) — staff
      // see ****<last4> by default and search the same masked tail. Recipient
      // name and sender phone stay fully searchable.
      const hay = `${t.recipientName} ${accountLast4(t.payoutDestination)} ${t.phone}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (fromMs !== null && Date.parse(t.createdAt) < fromMs) return false;
    if (toMs !== null && Date.parse(t.createdAt) >= toMs) return false;
    return true;
  });

  const partnerOptions = Object.values(props.partnerById);

  function onPartnerChange(value: string) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('partner', value);
    else url.searchParams.delete('partner');
    window.location.href = url.toString();
  }

  return (
    <>
      <div
        className="sh-toolbar"
        style={{ margin: 0, padding: '14px 16px', borderBottom: '1px solid var(--sh-border)' }}
      >
        <select
          value={props.currentPartner ?? ''}
          onChange={(e) => onPartnerChange(e.target.value)}
          className="sh-select"
          aria-label="Filter by partner"
        >
          <option value="">All partners</option>
          {partnerOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="sh-search-box sh-toolbar-grow">
          <span className="sh-search-box-icon"><Icon name="search" /></span>
          <input
            type="text"
            placeholder="Search recipient, account last-4, or sender phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="sh-input"
            aria-label="Search transactions"
          />
        </div>
        <label className="sh-scope-chip">
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="sh-inline-input"
          />
        </label>
        <label className="sh-scope-chip">
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="sh-inline-input"
          />
        </label>
      </div>
      <TransactionsTabs
        transfers={filtered}
        staff={props.staff}
        staffByUsername={props.staffByUsername}
        tierByPhone={props.tierByPhone}
        partnerById={props.partnerById}
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
