import Link from 'next/link';
import { t } from '@/lib/i18n';
import { Money, StatusPill } from '@/components/ds';
import { maskRecipientName } from '@/lib/partner-transfers';
import type { Transfer } from '@/lib/types';

// Lost-features p2 A10: one customer's live transfers on the customer page. Masked values only (the
// recipient as first word + initial, the destination as the ledger's `****last4` default read).
// Server-rendered, no client JS. Its own small list so the transfer pages' row component can change
// without touching this page.

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? DATE.format(new Date(iso)) : '—');
const FOCUS = 'rounded-ds-focus focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

export interface CustomerTransferRow {
  id: string;
  recipient: string;
  destination: string;
  amount: number;
  currency: string;
  status: Transfer['status'];
  refundStatus?: Transfer['refundStatus'];
  createdAt: string;
}

/** The ONLY fields a row carries (masked). */
export function toCustomerTransferRow(tr: Transfer): CustomerTransferRow {
  return {
    id: tr.id,
    recipient: maskRecipientName(tr.recipientName),
    destination: tr.payoutDestination.startsWith('****') ? tr.payoutDestination : '****',
    amount: tr.amountSource ?? tr.amountUsd,
    currency: tr.sourceCurrency ?? 'USD',
    status: tr.status,
    refundStatus: tr.refundStatus,
    createdAt: tr.createdAt,
  };
}

export function CustomerTransfers({ rows, olderHref }: { rows: CustomerTransferRow[]; olderHref: string | null }) {
  if (rows.length === 0) {
    return <p className="text-[14px] text-ds-ink-muted">{t('partner.customers.transfers.empty')}</p>;
  }
  return (
    <>
      <ul className="divide-y divide-ds-border" aria-label={t('partner.customers.transfers.caption')}>
        {rows.map((r) => (
          <li key={r.id} data-customer-transfer={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
            <span className="min-w-0">
              <Link href={`/partner/transfers/${r.id}`} className={`font-mono text-[13px] font-semibold text-ds-primary hover:underline ${FOCUS}`}>
                {r.id}
              </Link>
              <span className="block truncate text-[13px] text-ds-ink-muted">
                {r.recipient} · <span className="font-mono">{r.destination}</span> · {when(r.createdAt)}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ds-ink">
                <Money amount={r.amount} currency={r.currency} />
              </span>
              <StatusPill status={r.status} refundStatus={r.refundStatus} />
            </span>
          </li>
        ))}
      </ul>
      {olderHref ? (
        <Link
          href={olderHref}
          prefetch={false}
          className={`mt-3 inline-flex min-h-11 items-center text-[14px] font-semibold text-ds-primary underline-offset-4 hover:underline ${FOCUS}`}
        >
          {t('partner.customers.transfers.older')}
        </Link>
      ) : null}
    </>
  );
}
