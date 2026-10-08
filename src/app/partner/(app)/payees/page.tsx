import Link from 'next/link';
import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { t, type MessageKey } from '@/lib/i18n';
import type { PayeeStatus } from '@/lib/payees';
import { Badge, Card, EmptyState, PageHeader, buttonVariants, type Tone } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { AddPayeeForm } from './add-form';

export const metadata: Metadata = {
  title: t('partner.payees.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const STATUS: Record<PayeeStatus, { key: MessageKey; tone: Tone }> = {
  pending: { key: 'partner.payees.status.pending', tone: 'warning' },
  approved: { key: 'partner.payees.status.approved', tone: 'success' },
  rejected: { key: 'partner.payees.status.rejected', tone: 'danger' },
  suspended: { key: 'partner.payees.status.suspended', tone: 'neutral' },
};

/**
 * /partner/payees (Batch B2): this tenant's companies, newest first, and the form to add one.
 * Partner admin only; every read takes the SESSION's tenant. Bank details show the last 4 digits
 * only (the masked repo read); the full values never reach a partner page.
 */
export default async function PartnerPayeesPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.payees.policy);
  const payees = await createPayeeRepo(getDb()).listForPartner(ctx.partnerId);
  return (
    <>
      <PageHeader
        title={t('partner.payees.title')}
        sub={t('partner.payees.sub')}
        actions={
          <Link href={PARTNER_ROUTES.paymentLinks.href} prefetch={false} className={buttonVariants({ variant: 'ghost', size: 'md' })}>
            {t('partner.payees.back')}
          </Link>
        }
      />
      <Card as="section" className="mb-6 max-w-3xl p-5 sm:p-6">
        <h2 className="mb-4 text-[17px] font-semibold text-ds-ink">{t('partner.payees.add.title')}</h2>
        <AddPayeeForm />
      </Card>
      {payees.length === 0 ? (
        <EmptyState body={t('partner.payees.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface">
          <table className="w-full border-collapse text-left text-[14px] text-ds-ink" data-testid="partner-payees">
            <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-3">{t('partner.payees.col.name')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.payees.col.account')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.payees.col.status')}</th>
                <th scope="col" className="px-4 py-3">{t('partner.payees.col.added')}</th>
              </tr>
            </thead>
            <tbody>
              {payees.map((p) => (
                <tr key={p.id} className="border-t border-ds-border">
                  <td className="max-w-[280px] break-words px-4 py-3 font-semibold">{p.legalName}</td>
                  <td className="px-4 py-3 tabular-nums">{t('partner.payees.accountEnding', { last4: p.payoutLast4 })}</td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS[p.status].tone}>{t(STATUS[p.status].key)}</Badge>
                    {p.screening === 'review' && p.status === 'pending' ? (
                      <p className="mt-1 text-[13px] text-ds-ink-muted">{t('partner.payees.screeningReview')}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-ds-ink-muted">{p.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
