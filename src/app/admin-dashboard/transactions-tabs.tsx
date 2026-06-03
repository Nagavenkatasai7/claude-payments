'use client';

import { useState } from 'react';
import type { Partner, Staff, Tier, Transfer } from '@/lib/types';
import { money } from './format';
import { MaskedDestination } from './masked-destination';
import { ExpandableTable, type ExpandableColumn } from './expandable-table';
import { Icon } from './icons';
import { KycBadge, type KycInfo } from './kyc-badge';

const TRANSACTION_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Country' },
  { label: 'Partner' },
  { label: 'Tier' },
  { label: 'KYC' },
  { label: 'Amount', primary: true },
  { label: 'Funding' },
  { label: 'Payment received' },
  { label: 'Recipient gets' },
  { label: 'Compliance' },
  { label: 'Status', primary: true },
  { label: 'Assignee' },
  { label: 'Actions' },
];

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_payment', label: 'Awaiting' },
  { key: 'paid', label: 'Paid' },
  { key: 'in_review', label: 'In review' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'blocked', label: 'Blocked' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function humanizeFunding(method: Transfer['fundingMethod']): string {
  if (method === 'credit_card') return 'Credit card';
  if (method === 'debit_card') return 'Debit card';
  return 'Bank transfer';
}

function StatusPill({ status }: { status: Transfer['status'] }) {
  const klass =
    status === 'delivered' ? 'sh-pill-success'
    : status === 'paid' ? 'sh-pill-info'
    : status === 'in_review' ? 'sh-pill-warning'
    : status === 'awaiting_payment' ? 'sh-pill-neutral'
    : status === 'cancelled' ? 'sh-pill-warning'
    : 'sh-pill-danger';
  return (
    <span className={`sh-pill ${klass}`}>
      <span className="sh-pill-dot"></span>
      {status === 'in_review' ? 'In review' : status.replace('_', ' ')}
    </span>
  );
}

function ComplianceBadge({ status }: { status: Transfer['complianceStatus'] }) {
  const klass =
    status === 'cleared' ? 'sh-pill-success'
    : status === 'flagged' ? 'sh-pill-warning'
    : 'sh-pill-danger';
  return (
    <span className={`sh-pill ${klass}`}>
      <span className="sh-pill-dot"></span>
      {status}
    </span>
  );
}

function Stage({ at, fallback }: { at?: string; fallback: string }) {
  if (at) {
    return (
      <span className="sh-stage">
        <span className="sh-check"><Icon name="check" /></span>
        {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    );
  }
  return <span className="sh-stage-pending">{fallback}</span>;
}

export interface TransactionsTabsProps {
  transfers: Transfer[];
  staff: Staff[];
  staffByUsername: Record<string, string>;
  tierByPhone: Record<string, Tier>;
  kycByPhone: Record<string, KycInfo>;
  partnerById: Record<string, Partner>;
  canCancel: boolean;
  canResend: boolean;
  canAssign: boolean;
  cancelAction: (formData: FormData) => void | Promise<void>;
  assignAction: (formData: FormData) => void | Promise<void>;
  resendAction: (formData: FormData) => void | Promise<void>;
}

function tierBadgeClass(tier: Tier): string {
  if (tier === 'T0') return 'sh-tag sh-tag-tier-t0';
  if (tier === 'T1') return 'sh-tag sh-tag-tier-t1';
  return 'sh-tag sh-tag-tier-suspended';
}

export function TransactionsTabs({
  transfers,
  staff,
  staffByUsername,
  tierByPhone,
  kycByPhone,
  partnerById,
  canCancel,
  canResend,
  canAssign,
  cancelAction,
  assignAction,
  resendAction,
}: TransactionsTabsProps) {
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
      <ExpandableTable
        columns={TRANSACTION_COLUMNS}
        empty={<>No transactions in this view.</>}
        rows={visible.map((t) => ({
          key: t.id,
          label: t.recipientName,
          cells: [
            <div key="recipient">
              <div className="sh-recipient">{t.recipientName}</div>
              <MaskedDestination
                payoutMethod={t.payoutMethod}
                payoutDestination={t.payoutDestination}
              />
            </div>,
            <span key="country">{t.sourceCountry} → {t.destinationCountry}</span>,
            partnerById[t.partnerId]?.name ?? t.partnerId,
            tierByPhone[t.phone] ? (
              <span key="tier" className={tierBadgeClass(tierByPhone[t.phone])}>
                {tierByPhone[t.phone]}
              </span>
            ) : (
              <span key="tier" className="sh-recipient-sub">—</span>
            ),
            <KycBadge key="kyc" kyc={kycByPhone[t.phone]} />,
            <div key="amount">
              <div className="sh-amount">{money(t.amountSource, t.sourceCurrency)}</div>
              {t.sourceCurrency !== 'USD' && (
                <div className="sh-recipient-sub">≈ {money(t.amountUsd, 'USD')}</div>
              )}
              <div className="sh-recipient-sub">
                → {money(t.amountInr, t.destinationCurrency ?? 'INR')}
              </div>
            </div>,
            humanizeFunding(t.fundingMethod),
            <Stage key="paid" at={t.paidAt} fallback="pending" />,
            <Stage
              key="delivered"
              at={t.deliveredAt}
              fallback={t.status === 'paid' ? 'in transit' : '—'}
            />,
            <ComplianceBadge key="compliance" status={t.complianceStatus} />,
            <StatusPill key="status" status={t.status} />,
            t.assignedTo
              ? staffByUsername[t.assignedTo] ?? t.assignedTo
              : <span key="assignee" className="sh-recipient-sub">—</span>,
            <div key="actions" className="sh-attention-actions">
              {t.status === 'awaiting_payment' && canResend && (
                <form action={resendAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className="sh-mini-btn">Resend link</button>
                </form>
              )}
              {(t.status === 'awaiting_payment' || t.status === 'paid') && canCancel && (
                <form action={cancelAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Cancel</button>
                </form>
              )}
              {canAssign && (
                <form action={assignAction} className="sh-inline-form">
                  <input type="hidden" name="id" value={t.id} />
                  <select name="assignee" className="sh-inline-select" required>
                    <option value="">Assign…</option>
                    {staff.map((s) => (
                      <option key={s.username} value={s.username}>{s.name}</option>
                    ))}
                  </select>
                  <input type="text" name="note" placeholder="Note" className="sh-inline-input" />
                  <button type="submit" className="sh-mini-btn">Save</button>
                </form>
              )}
            </div>,
          ],
        }))}
      />
    </>
  );
}
