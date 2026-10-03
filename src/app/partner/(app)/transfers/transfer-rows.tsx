import Link from 'next/link';
import { FlaskConical, ShieldAlert } from 'lucide-react';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, Money, StatusPill } from '@/components/ds';
import { fundingView, isHeld, maskRecipientName } from '@/lib/partner-transfers';
import { complianceViewKey, type AssigneeView } from '@/lib/partner-transfer-ops';
import { maskPhoneLast4 } from '@/lib/mask';
import type { Transfer } from '@/lib/types';

// The tenant's transfers as a table from `sm` up and as stacked cards below it (375 px). Masked
// values only: the recipient name is first word + initial, the destination is the ledger's
// `****last4` default read, the sender phone is `••••last4`. The list page adds the full column set
// (lost-features p1 B2: sender, route, tier, KYC, funding, compliance, assignee) as closed labels
// only; the reviews page keeps the short set. Server-rendered, no client JS. The ds Table pages by number and total;
// this list pages by keyset, so the page renders its own pager (the M2 portal precedent).

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? DATE.format(new Date(iso)) : '—');
const FOCUS = 'rounded-ds-focus focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

export interface PartnerTransferRow {
  id: string;
  recipient: string;
  destination: string;
  amount: number;
  currency: string;
  status: Transfer['status'];
  refundStatus?: Transfer['refundStatus'];
  held: boolean;
  test: boolean;
  createdAt: string;
  /** The list page's extra columns (absent on the short list). */
  full?: PartnerTransferListColumns;
}

export interface PartnerTransferListColumns {
  sender: string;
  /** A sealed customer link (customer-link.ts), only for roles that may open customers. */
  customerHref?: string;
  route: string;
  received: { amount: number; currency: string };
  tier?: MessageKey;
  kyc?: MessageKey;
  funding: MessageKey;
  fundingState?: MessageKey;
  paidAt?: string;
  compliance: MessageKey;
  assignee: AssigneeView;
}

/** The ONLY fields a list row carries (masked); nothing else of the transfer reaches the HTML. */
export function toPartnerRow(tr: Transfer): PartnerTransferRow {
  return {
    id: tr.id,
    recipient: maskRecipientName(tr.recipientName),
    destination: tr.payoutDestination.startsWith('****') ? tr.payoutDestination : '****',
    amount: tr.amountSource ?? tr.amountUsd,
    currency: tr.sourceCurrency ?? 'USD',
    status: tr.status,
    refundStatus: tr.refundStatus,
    held: isHeld(tr),
    test: (tr.environment ?? 'live') === 'test',
    createdAt: tr.createdAt,
  };
}

/**
 * The list page's row: the short row plus the extra columns. Tier and KYC come from the page's
 * tenant-scoped sender-badge read (absent when the sender has no customer row, e.g. sandbox).
 */
export function toPartnerListRow(
  tr: Transfer,
  extra: { tier?: MessageKey; kyc?: MessageKey; customerHref?: string; assignee: AssigneeView },
): PartnerTransferRow {
  const funding = fundingView(tr);
  return {
    ...toPartnerRow(tr),
    full: {
      sender: maskPhoneLast4(tr.phone),
      ...(extra.customerHref ? { customerHref: extra.customerHref } : {}),
      route: `${tr.sourceCountry ?? 'US'} → ${tr.destinationCountry ?? 'IN'}`,
      received: { amount: tr.amountInr, currency: tr.destinationCurrency ?? 'INR' },
      ...(extra.tier ? { tier: extra.tier } : {}),
      ...(extra.kyc ? { kyc: extra.kyc } : {}),
      funding: funding.method,
      ...(funding.state ? { fundingState: funding.state } : {}),
      ...(tr.paidAt ? { paidAt: tr.paidAt } : {}),
      compliance: complianceViewKey(tr),
      assignee: extra.assignee,
    },
  };
}

function assigneeLabel(a: AssigneeView): string {
  if (a.kind === 'tenant') return a.username;
  return t(a.kind === 'smartremit' ? 'partner.transfers.assigneeSmartRemit' : 'partner.transfers.unassigned');
}

function CustomerLink({ href }: { href: string }) {
  // prefetch={false}: the customer page writes a pii.view row on render.
  return (
    <Link href={href} prefetch={false} className={`text-[12.5px] font-semibold text-ds-primary hover:underline ${FOCUS}`}>
      {t('partner.transfers.openCustomer')}
    </Link>
  );
}

function Flags({ r }: { r: PartnerTransferRow }) {
  return (
    <>
      {r.held ? (
        <Badge tone="warning">
          <ShieldAlert aria-hidden="true" className="size-3.5" />
          {t('partner.transfers.heldBadge')}
        </Badge>
      ) : null}
      {r.test ? (
        <Badge tone="neutral">
          <FlaskConical aria-hidden="true" className="size-3.5" />
          {t('partner.transfers.testBadge')}
        </Badge>
      ) : null}
    </>
  );
}

const TH = 'px-4 py-3 font-semibold';

export function TransferRows({ rows, caption }: { rows: PartnerTransferRow[]; caption: string }) {
  const full = rows.some((r) => r.full);
  return (
    <>
      <div className="hidden overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface sm:block">
        <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
            <tr>
              <th scope="col" className={TH}>{t('partner.transfers.colId')}</th>
              {full ? <th scope="col" className={TH}>{t('partner.transfers.colSender')}</th> : null}
              {full ? <th scope="col" className={TH}>{t('partner.transfers.colRoute')}</th> : null}
              <th scope="col" className={TH}>{t('partner.transfers.colRecipient')}</th>
              <th scope="col" className={TH}>{t('partner.transfers.colAmount')}</th>
              {full ? <th scope="col" className={TH}>{t('partner.transfers.colTier')}</th> : null}
              {full ? <th scope="col" className={TH}>{t('partner.transfers.colKyc')}</th> : null}
              {full ? <th scope="col" className={TH}>{t('partner.transfers.colFunding')}</th> : null}
              {full ? <th scope="col" className={TH}>{t('partner.transfers.colCompliance')}</th> : null}
              <th scope="col" className={TH}>{t('partner.transfers.colStatus')}</th>
              {full ? <th scope="col" className={TH}>{t('partner.transfers.colAssignee')}</th> : null}
              <th scope="col" className={TH}>{t('partner.transfers.colDate')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-ds-border" data-row={r.id}>
                <td className="px-4 py-3">
                  <Link href={`/partner/transfers/${r.id}`} className={`font-mono text-[13px] font-semibold text-ds-primary hover:underline ${FOCUS}`}>
                    {r.id}
                  </Link>
                </td>
                {full ? (
                  <td className="px-4 py-3">
                    <span className="block font-mono text-[13px]">{r.full?.sender ?? '—'}</span>
                    {r.full?.customerHref ? <CustomerLink href={r.full.customerHref} /> : null}
                  </td>
                ) : null}
                {full ? <td className="whitespace-nowrap px-4 py-3 text-ds-ink-muted">{r.full?.route ?? '—'}</td> : null}
                <td className="px-4 py-3">
                  <span className="block font-semibold">{r.recipient}</span>
                  <span className="block font-mono text-[12.5px] text-ds-ink-muted">{r.destination}</span>
                </td>
                <td className="px-4 py-3">
                  <Money amount={r.amount} currency={r.currency} />
                  {r.full ? (
                    <span className="block text-[12.5px] text-ds-ink-muted">
                      → <Money amount={r.full.received.amount} currency={r.full.received.currency} />
                    </span>
                  ) : null}
                </td>
                {full ? <td className="px-4 py-3">{r.full?.tier ? t(r.full.tier) : '—'}</td> : null}
                {full ? <td className="px-4 py-3">{r.full?.kyc ? t(r.full.kyc) : '—'}</td> : null}
                {full ? (
                  <td className="px-4 py-3">
                    {r.full ? (
                      <>
                        <span className="block">{t(r.full.funding)}</span>
                        {r.full.fundingState ? <span className="block text-[12.5px] text-ds-ink-muted">{t(r.full.fundingState)}</span> : null}
                        {r.full.paidAt ? (
                          <span className="block text-[12.5px] text-ds-ink-muted">{t('partner.transfers.fundingPaidOn', { date: when(r.full.paidAt) })}</span>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                ) : null}
                {full ? <td className="px-4 py-3">{r.full ? t(r.full.compliance) : '—'}</td> : null}
                <td className="px-4 py-3">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={r.status} refundStatus={r.refundStatus} />
                    <Flags r={r} />
                  </span>
                </td>
                {full ? <td className="px-4 py-3">{r.full ? assigneeLabel(r.full.assignee) : '—'}</td> : null}
                <td className="px-4 py-3 text-ds-ink-muted">{when(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul data-cards className="flex flex-col gap-3 sm:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/partner/transfers/${r.id}`}
              className={`flex flex-col gap-2 rounded-ds-card border border-ds-border bg-ds-surface p-4 hover:border-ds-primary/50 ${FOCUS}`}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-ds-ink">{r.recipient}</span>
                  <span className="block truncate font-mono text-[12.5px] text-ds-ink-muted">
                    {r.id} · {r.destination}
                  </span>
                </span>
                <span className="shrink-0 font-semibold text-ds-ink">
                  <Money amount={r.amount} currency={r.currency} />
                </span>
              </span>
              {r.full ? (
                <span className="flex flex-col gap-0.5 text-[13px] text-ds-ink-muted">
                  <span>
                    {t('partner.transfers.colSender')}: <span className="font-mono">{r.full.sender}</span> · {r.full.route}
                  </span>
                  <span>
                    {t('partner.transfers.colCompliance')}: {t(r.full.compliance)} · {t('partner.transfers.colAssignee')}: {assigneeLabel(r.full.assignee)}
                  </span>
                </span>
              ) : null}
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusPill status={r.status} refundStatus={r.refundStatus} />
                  <Flags r={r} />
                </span>
                <span className="text-[13px] text-ds-ink-muted">{when(r.createdAt)}</span>
              </span>
            </Link>
            {r.full?.customerHref ? (
              <span className="mt-1 block px-1">
                <CustomerLink href={r.full.customerHref} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
