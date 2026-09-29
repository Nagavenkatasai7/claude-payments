import Link from 'next/link';
import { FlaskConical, ShieldAlert } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Badge, Money, StatusPill } from '@/components/ds';
import { isHeld, maskRecipientName } from '@/lib/partner-transfers';
import type { Transfer } from '@/lib/types';

// The tenant's transfers as a table from `sm` up and as stacked cards below it (375 px). Masked
// values only: the recipient name is first word + initial, the destination is the ledger's
// `****last4` default read. Server-rendered, no client JS. The ds Table pages by number and total;
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

export function TransferRows({ rows, caption }: { rows: PartnerTransferRow[]; caption: string }) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface sm:block">
        <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">{t('partner.transfers.colId')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{t('partner.transfers.colRecipient')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{t('partner.transfers.colAmount')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{t('partner.transfers.colStatus')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{t('partner.transfers.colDate')}</th>
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
                <td className="px-4 py-3">
                  <span className="block font-semibold">{r.recipient}</span>
                  <span className="block font-mono text-[12.5px] text-ds-ink-muted">{r.destination}</span>
                </td>
                <td className="px-4 py-3">
                  <Money amount={r.amount} currency={r.currency} />
                </td>
                <td className="px-4 py-3">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={r.status} refundStatus={r.refundStatus} />
                    <Flags r={r} />
                  </span>
                </td>
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
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-1.5">
                  <StatusPill status={r.status} refundStatus={r.refundStatus} />
                  <Flags r={r} />
                </span>
                <span className="text-[13px] text-ds-ink-muted">{when(r.createdAt)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
