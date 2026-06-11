'use client';

import { useState } from 'react';
import type { Partner, Staff, Tier, Transfer } from '@/lib/types';
import { accountLast4 } from '@/lib/payout-format';
import { Input } from '@/components/ui/input';
import { TransactionsTabs } from './transactions-tabs';
import { Icon } from './icons';
import type { KycInfo } from './kyc-badge';

/* Native <select> restyled with a slate chevron (URL-encoded inline SVG) so it
 * matches the rest of the toolbar without changing the element or its events. */
const SELECT_CLASS =
  'h-9 cursor-pointer appearance-none rounded-md border border-input bg-card ' +
  "bg-[url('data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%2712%27%20height%3D%2712%27%20viewBox%3D%270%200%2012%2012%27%3E%3Cpath%20d%3D%27M3%204.5%206%207.5%209%204.5%27%20fill%3D%27none%27%20stroke%3D%27%2360646c%27%20stroke-width%3D%271.4%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%2F%3E%3C%2Fsvg%3E')] " +
  'bg-position-[right_10px_center] bg-no-repeat py-2 pr-[30px] pl-[11px] text-[13px] text-foreground outline-none ' +
  'focus:border-primary focus:ring-[3px] focus:ring-ring/30 max-md:w-full max-md:text-base';

export interface TransactionsExplorerProps {
  transfers: Transfer[];
  staff: Staff[];
  staffByUsername: Record<string, string>;
  tierByPhone: Record<string, Tier>;
  kycByPhone: Record<string, KycInfo>;
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
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5 max-md:flex-col max-md:items-stretch">
        <select
          value={props.currentPartner ?? ''}
          onChange={(e) => onPartnerChange(e.target.value)}
          className={SELECT_CLASS}
          aria-label="Filter by partner"
        >
          <option value="">All partners</option>
          {partnerOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="relative flex min-w-0 flex-[1_1_220px] items-center max-md:w-full">
          <span className="pointer-events-none absolute left-2.5 inline-flex text-muted-foreground">
            <Icon name="search" className="size-[15px]" />
          </span>
          <Input
            type="text"
            placeholder="Search recipient, account last-4, or sender phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-card pl-8"
            aria-label="Search transactions"
          />
        </div>
        <label className="inline-flex items-center gap-[5px] text-xs text-muted-foreground max-md:w-full">
          From
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-auto max-w-40 bg-card max-md:max-w-none max-md:flex-1"
          />
        </label>
        <label className="inline-flex items-center gap-[5px] text-xs text-muted-foreground max-md:w-full">
          To
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-auto max-w-40 bg-card max-md:max-w-none max-md:flex-1"
          />
        </label>
      </div>
      <TransactionsTabs
        transfers={filtered}
        staff={props.staff}
        staffByUsername={props.staffByUsername}
        tierByPhone={props.tierByPhone}
        kycByPhone={props.kycByPhone}
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
