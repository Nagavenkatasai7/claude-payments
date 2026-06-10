export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import {
  WINDOW_DAYS,
  type WindowDays,
  transfersInWindow,
  dailyCounts,
  dailyVolume,
  dailyCommission,
  statusDistribution,
  complianceDistribution,
  fundingMethodMix,
  topRecipientsByCount,
} from '@/lib/analytics';
import { Sidebar } from '../sidebar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  DailyTransfers,
  DailyVolume,
  DailyCommission,
  StatusDonut,
  ComplianceDonut,
  FundingMix,
  TopRecipients,
} from './charts';

function coerceWindow(raw: string | undefined): WindowDays {
  const n = Number(raw);
  return (WINDOW_DAYS as readonly number[]).includes(n) ? (n as WindowDays) : 30;
}

function usd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  const params = await searchParams;
  const windowDays = coerceWindow(params.window);
  const now = Date.now();

  const allTransfers = await scoped.listTransfers();
  const inWindow = transfersInWindow(allTransfers, now, windowDays);

  const counts = dailyCounts(allTransfers, now, windowDays);
  const volume = dailyVolume(allTransfers, now, windowDays);
  const commission = dailyCommission(allTransfers, now, windowDays);
  const statusDist = statusDistribution(inWindow);
  const complianceDist = complianceDistribution(inWindow);
  const funding = fundingMethodMix(inWindow);
  const topReci = topRecipientsByCount(inWindow, 10);

  const totalTransfers = inWindow.length;
  const totalVolume = inWindow.reduce((sum, t) => sum + t.amountUsd, 0);
  const totalCommission = inWindow
    .filter((t) => t.status === 'paid' || t.status === 'delivered')
    .reduce((sum, t) => sum + t.feeUsd, 0);

  return (
    <>
      <Sidebar active="analytics" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Analytics</div>
            <div className="sh-page-sub">Trends over the selected window</div>
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
            {WINDOW_DAYS.map((d) => (
              <Link
                key={d}
                href={`/admin-dashboard/analytics?window=${d}`}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                  windowDays === d
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {d}d
              </Link>
            ))}
          </div>
        </div>

        <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card className="border-primary/30 bg-accent/40">
            <CardHeader className="pb-2">
              <CardDescription>Transfers in window</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{totalTransfers}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Volume in window</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{usd(totalVolume)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Commission in window</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{usd(totalCommission)}</CardTitle>
            </CardHeader>
          </Card>
        </section>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Daily transfers</CardTitle>
            <CardDescription>Last {windowDays} days</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyTransfers data={counts} />
          </CardContent>
        </Card>

        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Daily volume (USD)</CardTitle>
              <CardDescription>Total amount sent per day</CardDescription>
            </CardHeader>
            <CardContent>
              <DailyVolume data={volume} />
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Daily commission (USD)</CardTitle>
              <CardDescription>Fees on paid/delivered transfers</CardDescription>
            </CardHeader>
            <CardContent>
              <DailyCommission data={commission} />
            </CardContent>
          </Card>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Status distribution</CardTitle>
              <CardDescription>Transfers in window by lifecycle status</CardDescription>
            </CardHeader>
            <CardContent>
              <StatusDonut data={statusDist} />
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Compliance distribution</CardTitle>
              <CardDescription>Cleared / flagged / blocked breakdown</CardDescription>
            </CardHeader>
            <CardContent>
              <ComplianceDonut data={complianceDist} />
            </CardContent>
          </Card>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Funding method mix</CardTitle>
            <CardDescription>How customers paid</CardDescription>
          </CardHeader>
          <CardContent>
            <FundingMix data={funding} />
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Top 10 recipients</CardTitle>
            <CardDescription>By number of transfers in window</CardDescription>
          </CardHeader>
          <CardContent>
            {topReci.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transfers in window.</p>
            ) : (
              <TopRecipients data={topReci} />
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
