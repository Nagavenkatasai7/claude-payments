'use client';

import { useState } from 'react';
import type { Partner, Staff, Tier, Transfer } from '@/lib/types';
import { money } from './format';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_payment', label: 'Awaiting' },
  { key: 'paid', label: 'Paid' },
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
    : status === 'awaiting_payment' ? 'sh-pill-neutral'
    : status === 'cancelled' ? 'sh-pill-warning'
    : 'sh-pill-danger';
  return (
    <span className={`sh-pill ${klass}`}>
      <span className="sh-pill-dot"></span>
      {status.replace('_', ' ')}
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
        <span className="sh-check">✓</span>
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
      <div className="sh-ledger-wrap">
        {visible.length === 0 ? (
          <div className="sh-empty">No transactions in this view.</div>
        ) : (
          <table className="sh-table">
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Country</th>
                <th>Partner</th>
                <th>Tier</th>
                <th>Amount</th>
                <th>Funding</th>
                <th>Payment received</th>
                <th>Recipient gets</th>
                <th>Compliance</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="sh-recipient">{t.recipientName}</div>
                    <div className="sh-recipient-sub">
                      {t.payoutMethod.toUpperCase()} · {t.payoutDestination}
                    </div>
                  </td>
                  <td>{t.sourceCountry} → {t.destinationCountry}</td>
                  <td>{partnerById[t.partnerId]?.name ?? t.partnerId}</td>
                  <td>
                    {tierByPhone[t.phone] ? (
                      <span className={tierBadgeClass(tierByPhone[t.phone])}>
                        {tierByPhone[t.phone]}
                      </span>
                    ) : (
                      <span className="sh-recipient-sub">—</span>
                    )}
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
                      ? staffByUsername[t.assignedTo] ?? t.assignedTo
                      : <span className="sh-recipient-sub">—</span>}
                  </td>
                  <td>
                    <div className="sh-attention-actions">
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
