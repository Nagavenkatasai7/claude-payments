import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { getPartnerStore } from '@/lib/partner-store';
import { listPartnerTransfers } from '@/db/repos/partner-transfer-reads';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { customerListRow, kycStatusKey } from '@/lib/partner-customer-view';
import { amlRuleKey, kycQueueCounts } from '@/lib/partner-reviews';
import { isTransferId, transfersListHref } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { Card, EmptyState, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { TransferRows, toPartnerRow } from '../transfers/transfer-rows';
import { AmlReviewForm } from './aml-review-form';
import { PartnerAmlExplain } from '../transfers/[id]/aml-explain';

export const metadata: Metadata = {
  title: t('partner.reviews.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const HELD_LIMIT = 50;
const KYC_LIMIT = 50;
const AML_LIMIT = 50;
const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const when = (iso: string | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? WHEN.format(new Date(iso)) : '—');
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const LINK = `rounded-ds-focus font-semibold text-ds-primary underline-offset-4 hover:underline ${FOCUS}`;
const TH = 'px-4 py-3 font-semibold';

function Section({ title, sub, testId, children }: { title: string; sub?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId}>
      <Card as="section" className="p-5 sm:p-6">
        <h2 className="text-[17px] font-bold text-ds-ink">{title}</h2>
        {sub ? <p className="mt-1 text-[13.5px] text-ds-ink-muted">{sub}</p> : null}
        <div className="mt-4">{children}</div>
      </Card>
    </div>
  );
}

function Tile({ label, kpi, value }: { label: string; kpi: string; value: number }) {
  return (
    <div className="rounded-ds-inner border border-ds-border bg-ds-ground p-4">
      <dt className="text-[13px] font-semibold text-ds-ink-muted">{label}</dt>
      <dd className="mt-1 text-[24px] font-extrabold tracking-[-0.02em] text-ds-ink tabular-nums" data-kpi={kpi}>
        {value}
      </dd>
    </div>
  );
}

/**
 * /partner/reviews (merge plan 2c). Everything is read with the SESSION tenant in the WHERE and
 * re-filtered to it (defence in depth). Sections:
 *  - held live transfers (masked rows; each links to its detail page, where the release and the
 *    reject & refund decisions are offered under D4);
 *  - customers awaiting a KYC decision (masked phone, closed KYC label, sealed-ref link; the
 *    queue is NEVER split or labelled by why a customer is in it, so a screening hit is not
 *    tipped off). In 'ours' mode one neutral line says SmartRemit reviews them;
 *  - D5: open behavioural (AML) alerts, ADMIN only: one rule label, a transfer link and the
 *    raised date. No count, amount, window or other rule detail reaches the page.
 * D6: flagged/blocked lists, the global watchlist, corridor rules and top velocity are not here.
 */
export default async function PartnerReviewsPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.reviews.policy);
  const isAdmin = PARTNER_ADMIN.roles.includes(ctx.role);
  const db = getDb();

  const [heldPage, queued, owner, alerts] = await Promise.all([
    listPartnerTransfers(db, ctx.partnerId, { status: 'in_review', environment: 'live', limit: HELD_LIMIT }),
    getKycCaseStore(getStore()).listNeedsReview(ctx.partnerId),
    getPartnerStore().getPartner(ctx.partnerId),
    isAdmin ? createAuditRepo(db).listOpenAmlAlerts(ctx.partnerId, AML_LIMIT) : Promise.resolve([]),
  ]);
  const held = heldPage.items.filter((tr) => tr.partnerId === ctx.partnerId);
  const mine = queued.filter((c) => c.partnerId === ctx.partnerId);
  const counts = kycQueueCounts(mine, ctx.partnerId);
  // Oldest waiting first (by when the row last changed), capped.
  const kycRows = [...mine]
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .slice(0, KYC_LIMIT)
    .map(customerListRow);
  const openAlerts = alerts.filter((a) => a.partnerId === ctx.partnerId && a.action === 'aml.alert');
  const delegated = owner?.kycMode === 'delegated';

  return (
    <>
      <PageHeader title={t('partner.reviews.title')} sub={t('partner.reviews.sub')} />
      <div className="flex flex-col gap-5">
        <Card as="section" className="p-5 sm:p-6">
          <h2 className="sr-only">{t('partner.reviews.title')}</h2>
          <dl className={`grid gap-4 ${isAdmin ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
            <Tile label={t('partner.reviews.tile.held')} kpi="held" value={held.length} />
            <Tile label={t('partner.reviews.tile.kycAwaiting')} kpi="kycAwaiting" value={counts.awaiting} />
            {isAdmin ? <Tile label={t('partner.reviews.tile.aml')} kpi="aml" value={openAlerts.length} /> : null}
          </dl>
        </Card>

        <Section title={t('partner.reviews.held.title')} sub={t('partner.reviews.held.sub')} testId="partner-reviews-held">
          {held.length === 0 ? (
            <EmptyState icon={<ShieldCheck aria-hidden="true" className="size-6" />} title={t('partner.reviews.held.empty')} />
          ) : (
            <>
              <TransferRows rows={held.map(toPartnerRow)} caption={t('partner.reviews.held.caption')} />
              {heldPage.nextCursor ? (
                <p className="mt-3 text-[13px] text-ds-ink-muted">
                  {t('partner.reviews.held.more', { n: HELD_LIMIT })}{' '}
                  <Link href={transfersListHref({ status: 'in_review', environment: 'live' })} className={LINK}>
                    {t('partner.nav.transfers')}
                  </Link>
                </p>
              ) : null}
            </>
          )}
        </Section>

        <Section
          title={t('partner.reviews.kyc.title')}
          sub={delegated ? t('partner.reviews.kyc.subDelegated') : t('partner.reviews.neutral')}
          testId="partner-reviews-kyc"
        >
          {kycRows.length === 0 ? (
            <EmptyState icon={<ShieldCheck aria-hidden="true" className="size-6" />} title={t('partner.reviews.kyc.empty')} />
          ) : (
            <div className="overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface">
              <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
                <caption className="sr-only">{t('partner.reviews.kyc.caption')}</caption>
                <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
                  <tr>
                    <th scope="col" className={TH}>{t('partner.customers.col.phone')}</th>
                    <th scope="col" className={TH}>{t('partner.customers.col.kyc')}</th>
                    <th scope="col" className={TH}>{t('partner.customers.col.created')}</th>
                    <th scope="col" className={TH}>{t('partner.customers.col.open')}</th>
                  </tr>
                </thead>
                <tbody>
                  {kycRows.map((row, i) => (
                    <tr key={i} className="border-t border-ds-border">
                      <td className="px-4 py-3 font-mono tabular-nums">{row.phone}</td>
                      <td className="px-4 py-3">{t(kycStatusKey(row.kycStatus))}</td>
                      <td className="px-4 py-3">{when(row.createdAt)}</td>
                      <td className="px-4 py-3">
                        <Link
                          href={`${PARTNER_ROUTES.customers.href}/${row.ref}`}
                          prefetch={false}
                          aria-label={t('partner.customers.openLabel', { phone: row.phone })}
                          className={LINK}
                        >
                          {t('partner.customers.open')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {isAdmin ? (
          <Section title={t('partner.reviews.aml.title')} sub={t('partner.reviews.aml.sub')} testId="partner-reviews-aml">
            {openAlerts.length === 0 ? (
              <EmptyState icon={<ShieldCheck aria-hidden="true" className="size-6" />} title={t('partner.reviews.aml.empty')} />
            ) : (
              <ul className="flex flex-col divide-y divide-ds-border" aria-label={t('partner.reviews.aml.caption')}>
                {openAlerts.map((a) => (
                  <li key={a.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0" data-alert={a.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-[14.5px] font-semibold text-ds-ink">{t(amlRuleKey(a.meta.rule))}</span>
                      <span className="text-[13px] text-ds-ink-muted">
                        {t('partner.reviews.aml.colRaised')}: {when(a.at)}
                      </span>
                    </div>
                    {isTransferId(a.subjectId) ? (
                      <span className="text-[13.5px] text-ds-ink-muted">
                        {t('partner.reviews.aml.colTransfer')}:{' '}
                        <Link href={`${PARTNER_ROUTES.transfers.href}/${a.subjectId}`} className={`font-mono ${LINK}`}>
                          {a.subjectId}
                        </Link>
                      </span>
                    ) : null}
                    <AmlReviewForm alertId={a.id} />
                    {isTransferId(a.subjectId) ? <PartnerAmlExplain transferId={a.subjectId} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : null}
      </div>
    </>
  );
}
