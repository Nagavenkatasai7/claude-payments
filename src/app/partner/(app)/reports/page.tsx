import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, Clock, Download, FileSpreadsheet, TriangleAlert, X } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createPartnerReportRepo } from '@/db/repos/partner-report-repo';
import {
  REPORT_KINDS,
  REPORT_LIST_LIMIT,
  reportAllows,
  reportView,
  type ReportDisplayStatus,
  type ReportListRow,
} from '@/lib/partner-reports';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, Card, EmptyState, PageHeader, buttonVariants, type Tone } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { ReportRequestForm } from './request-form';

export const metadata: Metadata = {
  title: t('partner.reports.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * /partner/reports (UI redesign M3-16): request a report (async), list this tenant's jobs, download
 * a ready one. The page is a money read; each KIND is further gated by reportPolicy, so the form
 * offers and the list shows only the kinds this role may open (the download route re-checks). The
 * list never reads the sealed content. The download is a plain <a download>, never a prefetching
 * <Link>: a prefetch GET would decrypt and write spurious report.download audit rows.
 */

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const STATUS: Record<ReportDisplayStatus, { tone: Tone; Icon: typeof Check }> = {
  queued: { tone: 'neutral', Icon: Clock },
  running: { tone: 'info', Icon: Clock },
  ready: { tone: 'success', Icon: Check },
  failed: { tone: 'danger', Icon: X },
  expired: { tone: 'neutral', Icon: X },
  stale: { tone: 'warning', Icon: TriangleAlert },
};

function StatusBadge({ status }: { status: ReportDisplayStatus }) {
  const { tone, Icon } = STATUS[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" className="size-3.5" />
      {t(`partner.reports.status.${status}` as MessageKey)}
    </Badge>
  );
}

function DownloadCell({ r }: { r: ReportListRow }) {
  if (!r.downloadable) return <span className="text-ds-ink-muted">—</span>;
  return (
    <span className="flex flex-col gap-1">
      <a href={`/partner/reports/${r.id}/download`} download className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        <Download aria-hidden="true" className="size-4" />
        {t('partner.reports.download')}
      </a>
      {r.expiresAt ? <span className="text-[12.5px] text-ds-ink-muted">{t('partner.reports.expires', { date: DAY.format(r.expiresAt) })}</span> : null}
    </span>
  );
}

export default async function PartnerReportsPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.reports.policy);
  const now = new Date();
  const jobs = await createPartnerReportRepo(getDb()).listJobs(ctx.partnerId, REPORT_LIST_LIMIT);
  const rows = jobs
    .map((j) => reportView(j, now))
    .filter((r): r is ReportListRow => r !== null && reportAllows(r.kind, ctx.role));
  const kinds = REPORT_KINDS.filter((k) => reportAllows(k, ctx.role));

  return (
    <>
      <PageHeader title={t('partner.reports.title')} sub={t('partner.reports.sub')} />
      <div className="flex flex-col gap-6">
        <Card as="section">
          <h2 className="text-[18px] font-bold text-ds-ink">{t('partner.reports.requestTitle')}</h2>
          <p className="mb-5 mt-1 text-[14px] text-ds-ink-muted">{t('partner.reports.requestIntro')}</p>
          <ReportRequestForm kinds={kinds} />
        </Card>

        <section className="flex flex-col gap-3" aria-labelledby="reports-list-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="reports-list-title" className="text-[18px] font-bold text-ds-ink">
              {t('partner.reports.listTitle')}
            </h2>
            <Link href={PARTNER_ROUTES.reports.href} className={buttonVariants({ variant: 'link', size: 'md' })} prefetch={false}>
              {t('partner.reports.refresh')}
            </Link>
          </div>
          {rows.length === 0 ? (
            <div data-empty>
              <EmptyState icon={<FileSpreadsheet className="size-5" />} title={t('partner.reports.emptyTitle')} body={t('partner.reports.emptyBody')} />
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface sm:block">
                <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
                  <caption className="sr-only">{t('partner.reports.caption')}</caption>
                  <thead className="bg-ds-ground text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('partner.reports.col.report')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('partner.reports.col.range')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('partner.reports.col.requested')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('partner.reports.col.status')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('partner.reports.col.rows')}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{t('partner.reports.col.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t border-ds-border align-top" data-row={r.id}>
                        <td className="px-4 py-3 font-semibold">{t(`partner.reports.kind.${r.kind}` as MessageKey)}</td>
                        <td className="px-4 py-3 font-mono text-[13px]">{r.range}</td>
                        <td className="px-4 py-3 text-ds-ink-muted">{DATE.format(r.createdAt)}</td>
                        <td className="px-4 py-3">
                          <span className="flex flex-col gap-1">
                            <StatusBadge status={r.status} />
                            {r.truncated && r.status === 'ready' ? <span className="text-[12.5px] text-ds-warning-ink">{t('partner.reports.truncated')}</span> : null}
                          </span>
                        </td>
                        <td className="px-4 py-3">{r.rowCount ?? '—'}</td>
                        <td className="px-4 py-3">
                          <DownloadCell r={r} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul data-cards className="flex flex-col gap-3 sm:hidden" aria-label={t('partner.reports.caption')}>
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-col gap-2 rounded-ds-card border border-ds-border bg-ds-surface p-4">
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block font-semibold text-ds-ink">{t(`partner.reports.kind.${r.kind}` as MessageKey)}</span>
                        <span className="block font-mono text-[12.5px] text-ds-ink-muted">{r.range}</span>
                      </span>
                      <StatusBadge status={r.status} />
                    </span>
                    {r.truncated && r.status === 'ready' ? <span className="text-[12.5px] text-ds-warning-ink">{t('partner.reports.truncated')}</span> : null}
                    <span className="text-[13px] text-ds-ink-muted">{DATE.format(r.createdAt)}</span>
                    <DownloadCell r={r} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}
