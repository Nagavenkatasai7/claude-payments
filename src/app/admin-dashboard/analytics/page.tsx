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
          <div className="sh-tabs">
            {WINDOW_DAYS.map((d) => (
              <Link
                key={d}
                href={`/admin-dashboard/analytics?window=${d}`}
                className={`sh-tab ${windowDays === d ? 'active' : ''}`}
              >
                {d}d
              </Link>
            ))}
          </div>
        </div>

        <section
          className="sh-metrics"
          style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}
        >
          <div className="sh-metric sh-metric-primary">
            <div className="sh-metric-label">Transfers in window</div>
            <div className="sh-metric-value">{totalTransfers}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Volume in window</div>
            <div className="sh-metric-value">{usd(totalVolume)}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Commission in window</div>
            <div className="sh-metric-value">{usd(totalCommission)}</div>
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Daily transfers</div>
              <div className="sh-card-sub">Last {windowDays} days</div>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            <DailyTransfers data={counts} />
          </div>
        </section>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 16,
            marginBottom: 16,
          }}
        >
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Daily volume (USD)</div>
                <div className="sh-card-sub">Total amount sent per day</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <DailyVolume data={volume} />
            </div>
          </section>
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Daily commission (USD)</div>
                <div className="sh-card-sub">Fees on paid/delivered transfers</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <DailyCommission data={commission} />
            </div>
          </section>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 16,
            marginBottom: 16,
          }}
        >
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Status distribution</div>
                <div className="sh-card-sub">Transfers in window by lifecycle status</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <StatusDonut data={statusDist} />
            </div>
          </section>
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Compliance distribution</div>
                <div className="sh-card-sub">Cleared / flagged / blocked breakdown</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <ComplianceDonut data={complianceDist} />
            </div>
          </section>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Funding method mix</div>
              <div className="sh-card-sub">How customers paid</div>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            <FundingMix data={funding} />
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Top 10 recipients</div>
              <div className="sh-card-sub">By number of transfers in window</div>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            {topReci.length === 0 ? (
              <div className="sh-empty">No transfers in window.</div>
            ) : (
              <TopRecipients data={topReci} />
            )}
          </div>
        </section>
      </main>
    </>
  );
}
