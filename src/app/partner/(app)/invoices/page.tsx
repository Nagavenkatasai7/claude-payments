import type { Metadata } from 'next';
import { FileText } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { INVOICE_PAGE_LIMIT, listPartnerInvoices } from '@/db/repos/partner-invoice-reads';
import { invoiceRow, type InvoiceRow } from '@/lib/partner-invoices';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { Badge, Card, EmptyState, Money, PageHeader } from '@/components/ds';
import type { Tone } from '@/lib/ui/transfer-status';
import { PARTNER_ROUTES } from '../../routes';
import { InvoiceControls } from './invoice-controls';

export const metadata: Metadata = {
  title: t('partner.invoices.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// /partner/invoices (lost-features A6): the SESSION tenant's business invoices, newest first and
// bounded. Admin only (the route policy). Rows are masked (partner-invoices.ts invoiceRow): the
// buyer is ••••last4 and line-item text is never shown. Void (unpaid) and Reissue (voided or
// disputed) confirm in a dialog; the server action re-gates and re-checks.

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const when = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? DATE.format(new Date(iso)) : '—');

type Shown = 'unpaid' | 'paid' | 'voided' | 'disputed' | 'expired';
const TONE: Record<Shown, Tone> = { unpaid: 'info', paid: 'success', voided: 'neutral', disputed: 'warning', expired: 'neutral' };
const shown = (r: InvoiceRow): Shown => (r.expired ? 'expired' : r.status);

function StatusBadge({ r }: { r: InvoiceRow }) {
  const s = shown(r);
  return <Badge tone={TONE[s]}>{t(`partner.invoices.status.${s}` as MessageKey)}</Badge>;
}

function Control({ r }: { r: InvoiceRow }) {
  return r.control ? <InvoiceControls id={r.id} control={r.control} /> : <span className="text-ds-ink-muted">—</span>;
}

export default async function PartnerInvoicesPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.invoices.policy);
  let rows: InvoiceRow[] | null;
  try {
    const now = new Date();
    rows = (await listPartnerInvoices(getDb(), ctx.partnerId, { limit: INVOICE_PAGE_LIMIT })).map((i) => invoiceRow(i, now));
  } catch (err) {
    logWarn('partner.invoices.list', err instanceof Error ? err.name : 'error', { partnerId: ctx.partnerId });
    rows = null;
  }

  return (
    <>
      <PageHeader title={t('partner.invoices.title')} sub={t('partner.invoices.sub')} />
      {rows === null ? (
        <Card as="section" className="p-4 sm:p-6">
          <p role="alert" className="text-[15px] text-ds-ink-muted">
            {t('partner.invoices.loadError')}
          </p>
        </Card>
      ) : rows.length === 0 ? (
        <div data-empty>
          <EmptyState icon={<FileText className="size-5" />} title={t('partner.invoices.empty')} body={t('partner.invoices.emptyBody')} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.length >= INVOICE_PAGE_LIMIT ? (
            <p className="text-[14px] text-ds-ink-muted">{t('partner.invoices.truncated', { count: INVOICE_PAGE_LIMIT })}</p>
          ) : null}
          <div className="hidden overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface lg:block">
            <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
              <caption className="sr-only">{t('partner.invoices.caption')}</caption>
              <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.id')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.seller')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.buyer')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.amount')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.status')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.created')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.paid')}</th>
                  <th scope="col" className="px-4 py-3 font-semibold">{t('partner.invoices.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-ds-border align-top" data-row={r.id}>
                    <td className="max-w-[220px] break-all px-4 py-3 font-mono text-[12.5px]">{r.id}</td>
                    <td className="px-4 py-3 font-semibold">{r.seller}</td>
                    <td className="px-4 py-3 font-mono text-[13px]">{r.buyer}</td>
                    <td className="px-4 py-3">
                      <Money amount={r.amount} currency={r.currency} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge r={r} />
                    </td>
                    <td className="px-4 py-3 text-ds-ink-muted">{when(r.createdAt)}</td>
                    <td className="px-4 py-3 text-ds-ink-muted">{when(r.paidAt)}</td>
                    <td className="px-4 py-3">
                      <Control r={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul data-cards className="flex flex-col gap-3 lg:hidden" aria-label={t('partner.invoices.caption')}>
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 rounded-ds-card border border-ds-border bg-ds-surface p-4">
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-ds-ink">{r.seller}</span>
                    <span className="block break-all font-mono text-[12.5px] text-ds-ink-muted">
                      {r.id} · {r.buyer}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold text-ds-ink">
                    <Money amount={r.amount} currency={r.currency} />
                  </span>
                </span>
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <StatusBadge r={r} />
                  <span className="text-[13px] text-ds-ink-muted">
                    {t('partner.invoices.col.created')}: {when(r.createdAt)}
                  </span>
                </span>
                <Control r={r} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
