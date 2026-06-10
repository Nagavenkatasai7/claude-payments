export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import Link from 'next/link';
import { schedulesDueInRange } from '@/lib/dashboard';
import type { Schedule, Transfer } from '@/lib/types';
import { money } from './format';
import { Sidebar } from './sidebar';
import { Icon } from './icons';
import { ExpandableTable, type ExpandableColumn } from './expandable-table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
function humanizeFunding(method: Transfer['fundingMethod']): string {
  if (method === 'credit_card') return 'Credit card';
  if (method === 'debit_card') return 'Debit card';
  return 'Bank transfer';
}

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

function scheduleWhen(s: Schedule): string {
  if (s.frequency === 'monthly') return `Monthly · day ${s.dayOfMonth}`;
  return `Weekly · ${WEEKDAYS[s.dayOfWeek ?? 0]}`;
}

// Glance table: Recipient/Amount/Status always visible on mobile; Funding behind tap.
const RECENT_TX_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'Funding' },
  { label: 'Status', primary: true },
];
// 3-column table: all primary → renders as a plain card on mobile (no toggle).
const NEXT_DUE_COLUMNS: ExpandableColumn[] = [
  { label: 'Recipient', primary: true },
  { label: 'Amount', primary: true },
  { label: 'When', primary: true },
];

function statusPillClass(status: Transfer['status']): string {
  if (status === 'delivered') return 'sh-pill-success';
  if (status === 'paid') return 'sh-pill-info';
  if (status === 'awaiting_payment') return 'sh-pill-neutral';
  if (status === 'cancelled') return 'sh-pill-warning';
  return 'sh-pill-danger';
}

export default async function DashboardPage() {
  const { staff } = await requireScope();
  const scoped = createScopedStore(staff);
  // Stage 4: SQL aggregates + an indexed recent-5 page — the overview no
  // longer serializes the whole ledger through JS on every render.
  const [summary, recent, schedules] = await Promise.all([
    scoped.transfersSummary(),
    scoped.recentTransfers(5),
    scoped.listSchedules(),
  ]);
  const now = Date.now();
  const attentionCount = summary.needsAttention;
  const nextDue = schedulesDueInRange(
    schedules.filter((s) => s.status === 'active'),
    now,
    365,
  ).slice(0, 3);
  const todayLabel = new Date(now).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <>
      <Sidebar active="overview" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Overview</div>
            <div className="sh-page-sub">{todayLabel}</div>
          </div>
        </div>

        <section className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Card className="border-primary/30 bg-accent/40">
            <CardHeader className="pb-2">
              <CardDescription>Commission today</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{usd(summary.commissionToday)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Volume today</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{usd(summary.volumeToday)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Transactions today</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{summary.countToday}</CardTitle>
            </CardHeader>
          </Card>
          <Card className={summary.flaggedToday > 0 ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Flagged today</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{summary.flaggedToday}</CardTitle>
            </CardHeader>
          </Card>
        </section>

        {attentionCount > 0 && (
          <Card className="mb-6 border-warning/50">
            <CardContent className="flex items-center gap-2 py-4 text-sm">
              <Icon name="warning" /> <strong>{attentionCount}</strong>{' '}
              {attentionCount === 1 ? 'transfer needs' : 'transfers need'} attention
              <Link
                href="/admin-dashboard/compliance"
                className="ml-auto text-primary underline-offset-2 hover:underline"
              >
                View on Compliance →
              </Link>
            </CardContent>
          </Card>
        )}

        <Card className="mb-6">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>Recent transactions</CardTitle>
              <CardDescription>Last 5</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin-dashboard/transactions">View all →</Link>
            </Button>
          </CardHeader>
          <ExpandableTable
            columns={RECENT_TX_COLUMNS}
            empty={<>No transactions yet.</>}
            rows={recent.map((t) => ({
              key: t.id,
              label: t.recipientName,
              cells: [
                <div className="sh-recipient" key="r">{t.recipientName}</div>,
                <div key="a">
                  <div className="sh-amount">{money(t.amountSource, t.sourceCurrency)}</div>
                  {t.sourceCurrency !== 'USD' && (
                    <div className="sh-recipient-sub">≈ {money(t.amountUsd, 'USD')}</div>
                  )}
                  <div className="sh-recipient-sub">
                    → {money(t.amountInr, t.destinationCurrency ?? 'INR')}
                  </div>
                </div>,
                humanizeFunding(t.fundingMethod),
                <span className={`sh-pill ${statusPillClass(t.status)}`} key="s">
                  <span className="sh-pill-dot"></span>
                  {t.status.replace('_', ' ')}
                </span>,
              ],
            }))}
          />
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>Next due schedules</CardTitle>
              <CardDescription>Next 3</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin-dashboard/schedules">View all →</Link>
            </Button>
          </CardHeader>
          <ExpandableTable
            columns={NEXT_DUE_COLUMNS}
            empty={<>No schedules due soon.</>}
            rows={nextDue.map((s) => ({
              key: s.id,
              label: s.recipientName,
              cells: [
                <div className="sh-recipient" key="r">{s.recipientName}</div>,
                <span className="sh-amount" key="a">{money(s.amountSource, s.sourceCurrency)}</span>,
                scheduleWhen(s),
              ],
            }))}
          />
        </Card>
      </main>
    </>
  );
}
