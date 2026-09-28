import Link from 'next/link';
import { t } from '@/lib/i18n';
import { Money, StatusPill } from '@/components/ds';
import type { PortalTransferRow } from '@/lib/portal-transfers';

// The customer's transfers as a table from `sm` up and as stacked cards below it (375 px). Masked
// rows only (the destination is the ledger's `****last4`). Server-rendered, no client JS. The ds
// Table is page-number based; this list pages by keyset, so the caller renders the pager.

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? DATE.format(new Date(iso)) : '—');
const FOCUS = 'rounded-ds-focus focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';

export function TransferRows({ rows, caption }: { rows: PortalTransferRow[]; caption: string }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-ds-card border border-ds-border bg-ds-surface sm:block">
        <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">{t('portal.transfers.colRecipient')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{t('portal.transfers.colAmount')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{t('portal.transfers.colStatus')}</th>
              <th scope="col" className="px-4 py-3 font-semibold">{t('portal.transfers.colDate')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-ds-border">
                <td className="px-4 py-3">
                  <Link href={`/portal/transfers/${r.id}`} className={`font-semibold text-ds-primary hover:underline ${FOCUS}`}>
                    {r.recipientName}
                  </Link>
                  <span className="block font-mono text-[12.5px] text-ds-ink-muted">{r.maskedDestination}</span>
                </td>
                <td className="px-4 py-3">
                  <Money amount={r.amount} currency={r.currency} />
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={r.status} refundStatus={r.refundStatus} />
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
              href={`/portal/transfers/${r.id}`}
              className={`flex flex-col gap-2 rounded-ds-card border border-ds-border bg-ds-surface p-4 hover:border-ds-primary/50 ${FOCUS}`}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-ds-ink">{r.recipientName}</span>
                  <span className="block font-mono text-[12.5px] text-ds-ink-muted">{r.maskedDestination}</span>
                </span>
                <span className="shrink-0 font-semibold text-ds-ink">
                  <Money amount={r.amount} currency={r.currency} />
                </span>
              </span>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <StatusPill status={r.status} refundStatus={r.refundStatus} />
                <span className="text-[13px] text-ds-ink-muted">{when(r.createdAt)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
