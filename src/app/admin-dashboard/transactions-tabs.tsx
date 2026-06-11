'use client';

import { useState, type ReactNode } from 'react';
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

/* Semantic status pills (Radix ramps: step-3 bg / step-6 border / step-9 dot /
 * step-11 text — same hexes the legacy pill classes used). */
const PILL_BASE =
  'inline-flex items-center gap-[5px] whitespace-nowrap rounded-full border px-[9px] py-[2px] text-[11.5px] font-semibold';
const PILL = {
  success: 'border-[#adddc0] bg-[#effaf2] text-[#1a7049]',
  warning: 'border-[#f3d673] bg-[#fdfbe7] text-[#9a5b00]',
  danger: 'border-[#fdbdbe] bg-[#feebec] text-[#ce2c31]',
  info: 'border-[#acd8fc] bg-[#eff6ff] text-[#0a5fa8]',
  neutral: 'border-[#d9d9e0] bg-[#f0f0f3] text-[#60646c]',
} as const;
const PILL_DOT = {
  success: 'bg-[#30a46c]',
  warning: 'bg-[#ffc53d]',
  danger: 'bg-[#e5484d]',
  info: 'bg-[#0090ff]',
  neutral: 'bg-[#8b8d98]',
} as const;
type PillTone = keyof typeof PILL;

const SUB_TEXT = 'mt-[3px] text-[11.5px] text-muted-foreground';

const MINI_BTN_BASE =
  'inline-flex min-h-[30px] cursor-pointer items-center justify-center gap-[5px] rounded-md border px-2.5 text-xs font-medium transition-colors max-md:min-h-10';
const MINI_BTN = `${MINI_BTN_BASE} border-input bg-card text-foreground hover:bg-background`;
const MINI_BTN_DANGER = `${MINI_BTN_BASE} border-[#fdbdbe] bg-card text-destructive hover:bg-[#feebec]`;

const INLINE_CONTROL =
  'rounded-md border border-input bg-card px-[9px] py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-ring/30 max-md:text-base';

function humanizeFunding(method: Transfer['fundingMethod']): string {
  if (method === 'credit_card') return 'Credit card';
  if (method === 'debit_card') return 'Debit card';
  return 'Bank transfer';
}

function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={`${PILL_BASE} ${PILL[tone]}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PILL_DOT[tone]}`}></span>
      {children}
    </span>
  );
}

function StatusPill({ status }: { status: Transfer['status'] }) {
  const tone: PillTone =
    status === 'delivered' ? 'success'
    : status === 'paid' ? 'info'
    : status === 'in_review' ? 'warning'
    : status === 'awaiting_payment' ? 'neutral'
    : status === 'cancelled' ? 'warning'
    : 'danger';
  return (
    <Pill tone={tone}>
      {status === 'in_review' ? 'In review' : status.replace('_', ' ')}
    </Pill>
  );
}

function ComplianceBadge({ status }: { status: Transfer['complianceStatus'] }) {
  const tone: PillTone =
    status === 'cleared' ? 'success'
    : status === 'flagged' ? 'warning'
    : 'danger';
  return <Pill tone={tone}>{status}</Pill>;
}

function Stage({ at, fallback }: { at?: string; fallback: string }) {
  if (at) {
    return (
      <span className="inline-flex items-center gap-[5px] text-[12.5px] text-foreground tabular-nums">
        <span className="inline-flex font-bold text-success">
          <Icon name="check" className="size-[13px]" />
        </span>
        {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    );
  }
  return <span className="text-[12.5px] text-muted-foreground">{fallback}</span>;
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
  if (tier === 'T0') return `${PILL_BASE} ${PILL.warning}`;
  if (tier === 'T1') return `${PILL_BASE} ${PILL.success}`;
  return `${PILL_BASE} ${PILL.danger}`;
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
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <div className="text-[15px] font-semibold tracking-[-0.2px] text-foreground">Transactions</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {visible.length} of {transfers.length} transfers
          </div>
        </div>
        <div className="inline-flex flex-wrap gap-0.5 rounded-md bg-muted p-[3px] max-md:w-full">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`cursor-pointer rounded-[5px] px-3 py-[5px] text-[12.5px] transition-colors ${
                tab === t.key
                  ? 'bg-card font-semibold text-foreground shadow-sm'
                  : 'bg-transparent font-medium text-muted-foreground hover:text-foreground'
              }`}
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
              <div className="font-semibold text-foreground">{t.recipientName}</div>
              <MaskedDestination
                transferId={t.id}
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
              <span key="tier" className={SUB_TEXT}>—</span>
            ),
            <KycBadge key="kyc" kyc={kycByPhone[t.phone]} />,
            <div key="amount">
              <div className="font-semibold tabular-nums">{money(t.amountSource, t.sourceCurrency)}</div>
              {t.sourceCurrency !== 'USD' && (
                <div className={SUB_TEXT}>≈ {money(t.amountUsd, 'USD')}</div>
              )}
              <div className={SUB_TEXT}>
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
              : <span key="assignee" className={SUB_TEXT}>—</span>,
            <div key="actions" className="flex flex-wrap gap-1.5">
              {t.status === 'awaiting_payment' && canResend && (
                <form action={resendAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className={MINI_BTN}>Resend link</button>
                </form>
              )}
              {(t.status === 'awaiting_payment' || t.status === 'paid') && canCancel && (
                <form action={cancelAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className={MINI_BTN_DANGER}>Cancel</button>
                </form>
              )}
              {canAssign && (
                <form action={assignAction} className="flex flex-wrap items-center gap-1.5 max-md:flex-col max-md:items-stretch">
                  <input type="hidden" name="id" value={t.id} />
                  <select name="assignee" className={`cursor-pointer ${INLINE_CONTROL}`} required>
                    <option value="">Assign…</option>
                    {staff.map((s) => (
                      <option key={s.username} value={s.username}>{s.name}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    name="note"
                    placeholder="Note"
                    className={`max-w-[110px] placeholder:text-muted-foreground max-md:w-full max-md:max-w-none ${INLINE_CONTROL}`}
                  />
                  <button type="submit" className={MINI_BTN}>Save</button>
                </form>
              )}
            </div>,
          ],
        }))}
      />
    </>
  );
}
