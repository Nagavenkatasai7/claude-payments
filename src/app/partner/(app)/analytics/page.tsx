import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requirePartnerStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { listPartnerLiveTransfersSince } from '@/db/repos/partner-analytics-reads';
import { PARTNER_ROUTES } from '../../routes';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { WINDOW_DAYS } from '@/lib/analytics';
import { ANALYTICS_ROW_CAP, analyticsHref, buildPartnerAnalytics, parseAnalyticsWindow, type PartnerAnalytics } from '@/lib/partner-analytics';
import { Card, EmptyState, Money, PageHeader } from '@/components/ds';
import { dsCn } from '@/lib/ui/ds-cn';
import { ComplianceDonut, DailyCommission, DailyTransfers, DailyVolume, FundingMix, StatusDonut } from '@/components/charts/transfer-charts';

export const metadata: Metadata = { title: t('partner.analytics.title'), robots: { index: false, follow: false } };

// /partner/analytics (merge plan 2d): charts over the SESSION tenant's live transfers for a 7/30/90
// day window (?window=, allowlisted). The read takes the tenant from requirePartnerStaff only, and
// the view model (lib/partner-analytics) holds counts, amounts and enums: no recipient name or
// phone reaches the page (the legacy top-recipients chart is not offered). The charts are the shared
// components the legacy analytics page uses too.

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring';
const H2 = 'text-[17px] font-semibold text-ds-ink';

function ChartCard({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <Card as="section" className="min-w-0 p-4 sm:p-6">
      <h2 className={H2}>{title}</h2>
      <p className="mb-3 text-[13.5px] text-ds-ink-muted">{sub}</p>
      {children}
    </Card>
  );
}

function Tile({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="rounded-ds-inner border border-ds-border bg-ds-ground p-4">
      <dt className="text-[13px] font-semibold text-ds-ink-muted">{label}</dt>
      <dd className="mt-1 text-[24px] font-extrabold tracking-[-0.02em] text-ds-ink tabular-nums" data-kpi={testId}>
        {children}
      </dd>
    </div>
  );
}

export default async function PartnerAnalyticsPage({ searchParams }: { searchParams: Promise<{ window?: string | string[] }> }) {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.analytics.policy);
  const sp = await searchParams;
  const days = parseAnalyticsWindow(sp.window);
  const now = Date.now();

  let model: PartnerAnalytics | null = null;
  try {
    const { items, truncated } = await listPartnerLiveTransfersSince(getDb(), ctx.partnerId, { now, days, cap: ANALYTICS_ROW_CAP });
    model = buildPartnerAnalytics(items, now, days, truncated);
  } catch (err) {
    // The error NAME only: a failed query's message carries its bound params.
    logWarn('partner.analytics', errName(err), { partnerId: ctx.partnerId });
  }

  return (
    <>
      <PageHeader
        title={t('partner.analytics.title')}
        sub={t('partner.analytics.sub')}
        actions={
          <nav aria-label={t('partner.analytics.windowLabel')} className="flex flex-wrap gap-2">
            {WINDOW_DAYS.map((d) => (
              <Link
                key={d}
                href={analyticsHref(d)}
                aria-current={d === days ? 'page' : undefined}
                className={dsCn(
                  'inline-flex min-h-10 items-center rounded-full border px-4 text-[13.5px] font-semibold',
                  d === days ? 'border-ds-primary bg-ds-tint text-ds-ink' : 'border-ds-border-strong bg-ds-surface text-ds-ink-muted hover:text-ds-ink',
                  FOCUS,
                )}
              >
                {t('partner.analytics.windowDays', { days: d })}
              </Link>
            ))}
          </nav>
        }
      />
      {model === null ? (
        <div role="alert" className="rounded-ds-card border border-ds-border bg-ds-surface p-6 text-[15px] text-ds-ink-muted">
          {t('partner.analytics.loadError')}
        </div>
      ) : (
        <div className="flex flex-col gap-4 lg:gap-6">
          <Card as="section" className="p-4 sm:p-6">
            <h2 className={H2}>{t('partner.analytics.totalsTitle', { days })}</h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <Tile label={t('partner.analytics.kpi.count')} testId="count">
                {model.totals.count}
              </Tile>
              <Tile label={t('partner.analytics.kpi.volume')} testId="volume">
                <Money amount={model.totals.volumeUsd} currency="USD" />
              </Tile>
              <Tile label={t('partner.analytics.kpi.fees')} testId="fees">
                <Money amount={model.totals.commissionUsd} currency="USD" />
              </Tile>
            </dl>
            <p className="mt-3 text-[13px] text-ds-ink-subtle">{t('partner.analytics.liveNote')}</p>
            {model.truncated ? (
              <p role="status" className="mt-2 text-[13px] font-semibold text-ds-ink-muted">
                {t('partner.analytics.truncated', { count: ANALYTICS_ROW_CAP })}
              </p>
            ) : null}
          </Card>
          {model.totals.count === 0 ? (
            <EmptyState title={t('partner.analytics.emptyTitle')} body={t('partner.analytics.emptyBody')} />
          ) : (
            <>
              <ChartCard title={t('partner.analytics.chart.daily')} sub={t('partner.analytics.chart.dailySub', { days })}>
                <DailyTransfers data={model.daily.counts} />
              </ChartCard>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
                <ChartCard title={t('partner.analytics.chart.volume')} sub={t('partner.analytics.chart.volumeSub')}>
                  <DailyVolume data={model.daily.volume} />
                </ChartCard>
                <ChartCard title={t('partner.analytics.chart.fees')} sub={t('partner.analytics.chart.feesSub')}>
                  <DailyCommission data={model.daily.commission} />
                </ChartCard>
                <ChartCard title={t('partner.analytics.chart.status')} sub={t('partner.analytics.chart.statusSub')}>
                  <StatusDonut data={model.status} />
                </ChartCard>
                <ChartCard title={t('partner.analytics.chart.compliance')} sub={t('partner.analytics.chart.complianceSub')}>
                  <ComplianceDonut data={model.compliance} />
                </ChartCard>
              </div>
              <ChartCard title={t('partner.analytics.chart.funding')} sub={t('partner.analytics.chart.fundingSub')}>
                <FundingMix data={model.funding} />
              </ChartCard>
            </>
          )}
        </div>
      )}
    </>
  );
}
