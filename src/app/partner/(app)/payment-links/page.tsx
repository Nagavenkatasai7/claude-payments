import Link from 'next/link';
import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { isFlagOn } from '@/lib/flags';
import { t, type MessageKey } from '@/lib/i18n';
import { linkDisplayStatus, type LinkDisplayStatus } from '@/lib/payment-links';
import { BULK_TEMPLATE_CSV } from '@/lib/payment-link-bulk';
import { PURPOSE_LABELS, TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import { paymentLinkUrl } from '@/lib/pay-url';
import { Badge, Card, EmptyState, Input, PageHeader, buttonVariants, type Tone } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { CreateLinkForm } from './create-form';
import { BulkUploadForm } from './bulk-form';
import { CopyButton } from './copy-button';
import { CancelLinkButton } from './cancel-button';

export const metadata: Metadata = {
  title: t('partner.paymentLinks.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const STATUS: Record<LinkDisplayStatus, { key: MessageKey; tone: Tone }> = {
  open: { key: 'partner.paymentLinks.status.open', tone: 'info' },
  paid: { key: 'partner.paymentLinks.status.paid', tone: 'success' },
  processing: { key: 'partner.paymentLinks.status.processing', tone: 'warning' },
  not_paid: { key: 'partner.paymentLinks.status.not_paid', tone: 'danger' },
  cancelled: { key: 'partner.paymentLinks.status.cancelled', tone: 'neutral' },
  expired: { key: 'partner.paymentLinks.status.expired', tone: 'neutral' },
};

const inr = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n);
const maskedPhone = (digits: string) => `••••${digits.slice(-4)}`;

/**
 * /partner/payment-links (Batch B2): make a link per customer (one, or a CSV file), copy or
 * download them, search by reference, see each link's status and open the paid transfer. Partner
 * admin only; every read takes the SESSION's tenant (the repo joins the payee and the transfer on
 * that same tenant). Customer phones show the last 4 digits; the full link list with phones is the
 * audited CSV download.
 */
export default async function PartnerPaymentLinksPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.paymentLinks.policy);
  const params = await searchParams;
  const q = (typeof params.q === 'string' ? params.q : '').trim().slice(0, 64);
  const db = getDb();
  const [approved, links, enabled] = await Promise.all([
    createPayeeRepo(db).listForPartner(ctx.partnerId, { status: 'approved' }),
    createPaymentLinkRepo(db).listForPartner(ctx.partnerId, { reference: q, limit: 200 }),
    isFlagOn(db, 'paylinks.enabled', { partnerId: ctx.partnerId }),
  ]);
  const payees = approved.filter((p) => p.screening === 'clear').map((p) => ({ id: p.id, legalName: p.legalName }));
  const purposes = TRANSFER_PURPOSES.map((code) => ({ code, label: PURPOSE_LABELS[code] }));
  const now = new Date();

  return (
    <>
      <PageHeader
        title={t('partner.paymentLinks.title')}
        sub={t('partner.paymentLinks.sub')}
        actions={
          <>
            <Link href={PARTNER_ROUTES.payees.href} prefetch={false} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
              {t('partner.paymentLinks.payees')}
            </Link>
            <a href={`${PARTNER_ROUTES.paymentLinks.href}/download`} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
              {t('partner.paymentLinks.downloadAll')}
            </a>
          </>
        }
      />
      {!enabled ? (
        <p role="status" className="mb-5 rounded-ds-inner border border-ds-warning-border bg-ds-warning-bg p-4 text-[14px] text-ds-warning-ink">
          {t('partner.paymentLinks.switchOff')}
        </p>
      ) : null}

      {payees.length === 0 ? (
        <Card as="section" className="mb-6 p-5 sm:p-6">
          <p className="text-[15px] text-ds-ink-muted">{t('partner.paymentLinks.noPayees')}</p>
        </Card>
      ) : (
        <div className="mb-6 grid gap-6 xl:grid-cols-2">
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="mb-4 text-[17px] font-semibold text-ds-ink">{t('partner.paymentLinks.create.title')}</h2>
            <CreateLinkForm payees={payees} purposes={purposes} />
          </Card>
          <Card as="section" className="p-5 sm:p-6">
            <h2 className="mb-1 text-[17px] font-semibold text-ds-ink">{t('partner.paymentLinks.bulk.title')}</h2>
            <p className="mb-4 text-[14px] text-ds-ink-muted">{t('partner.paymentLinks.bulk.sub')}</p>
            <BulkUploadForm payees={payees} templateCsv={BULK_TEMPLATE_CSV} />
          </Card>
        </div>
      )}

      <form method="get" className="mb-4 flex max-w-md items-end gap-2" role="search">
        <label className="flex flex-1 flex-col text-[14px] font-semibold text-ds-ink">
          {t('partner.paymentLinks.search')}
          <Input name="q" defaultValue={q} maxLength={64} autoComplete="off" className="mt-1.5" />
        </label>
        <button type="submit" className={buttonVariants({ variant: 'ghost', size: 'md' })}>
          {t('partner.paymentLinks.searchSubmit')}
        </button>
      </form>

      {links.length === 0 ? (
        <EmptyState body={q ? t('partner.paymentLinks.noMatch') : t('partner.paymentLinks.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface">
          <table className="w-full border-collapse text-left text-[14px] text-ds-ink" data-testid="partner-paylinks">
            <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-3">{t('partner.paymentLinks.col.reference')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.paymentLinks.col.customer')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.paymentLinks.col.amount')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.paymentLinks.col.company')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.paymentLinks.col.status')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.paymentLinks.col.expires')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.paymentLinks.col.link')}</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => {
                const status = linkDisplayStatus(l, l.transferStatus, now);
                return (
                  <tr key={l.id} className="border-t border-ds-border align-top">
                    <td className="max-w-[180px] break-words px-4 py-3 font-semibold">{l.reference}</td>
                    <td className="max-w-[180px] break-words px-4 py-3">
                      {l.customerName}
                      <span className="block text-[13px] text-ds-ink-muted tabular-nums">{maskedPhone(l.customerPhone)}</span>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{inr(l.amountInr)}</td>
                    <td className="max-w-[200px] break-words px-4 py-3">{l.payeeName}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS[status].tone}>{t(STATUS[status].key)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-ds-ink-muted">{l.expiresAt.toISOString().slice(0, 10)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {status === 'open' ? (
                          <>
                            <CopyButton text={paymentLinkUrl(l.token)} />
                            <CancelLinkButton linkId={l.id} />
                          </>
                        ) : null}
                        {l.transferId && l.transferStatus ? (
                          <Link
                            href={`/partner/transfers/${encodeURIComponent(l.transferId)}`}
                            prefetch={false}
                            className={buttonVariants({ variant: 'link', size: 'sm' })}
                          >
                            {t('partner.paymentLinks.viewTransfer')}
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
