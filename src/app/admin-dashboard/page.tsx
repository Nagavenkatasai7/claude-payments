export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { getDb } from '@/db/client';
import { resolveSenderNames, senderNameKey } from '@/lib/sender-names';
import Link from 'next/link';
import { schedulesDueInRange } from '@/lib/dashboard';
import type { Schedule, Transfer } from '@/lib/types';
import { money } from './format';
import { Sidebar } from './sidebar';
import { Icon } from './icons';
import { SenderCell } from './sender-cell';
import { ExpandableTable, type ExpandableColumn } from './expandable-table';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { greetingFor } from '@/lib/staff-greeting';
import type { IconName } from './icons';
import { Button } from '@/components/ui/button';

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  { label: 'Sender' },
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
  if (status === 'delivered') return 'border-success/50 text-success';
  if (status === 'paid') return 'border-primary/50 text-primary';
  if (status === 'awaiting_payment') return 'border-border text-muted-foreground';
  if (status === 'cancelled') return 'border-warning/50 text-warning';
  return 'border-destructive/50 text-destructive';
}

// The four "today" numbers as tiles: an icon chip, the label and the figure.
function StatTile({ label, value, icon, tone = 'brand' }: { label: string; value: string; icon: IconName; tone?: 'brand' | 'alert' }) {
  const chip =
    tone === 'alert'
      ? 'border-ds-danger-border bg-ds-danger-bg text-ds-danger-ink'
      : 'border-ds-border bg-ds-tint text-primary';
  return (
    <Card className={`gap-0 py-5 ${tone === 'alert' ? 'border-ds-danger-border' : ''}`}>
      <div className="flex items-start justify-between gap-3 px-5">
        <div>
          <CardDescription className="text-[13px] font-medium">{label}</CardDescription>
          <div className="mt-1.5 text-[28px] leading-none font-extrabold tracking-[-0.02em] tabular-nums">{value}</div>
        </div>
        <span aria-hidden="true" className={`flex size-10 shrink-0 items-center justify-center rounded-ds-inner border [&_svg]:size-[18px] ${chip}`}>
          <Icon name={icon} />
        </span>
      </div>
    </Card>
  );
}

// Shortcuts for platform admins (the same pages the sidebar links; every page re-gates itself).
const QUICK_LINKS: Array<{ href: string; label: string; sub: string; icon: IconName }> = [
  { href: '/admin-dashboard/compliance', label: 'Compliance', sub: 'Holds and reviews', icon: 'compliance' },
  { href: '/admin-dashboard/transactions', label: 'Transactions', sub: 'Every transfer', icon: 'transactions' },
  { href: '/admin-dashboard/customers', label: 'Customers', sub: 'Senders and KYC', icon: 'customers' },
  { href: '/admin-dashboard/partners', label: 'Partners', sub: 'Licensed partners', icon: 'partners' },
];

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
  const senderNames = await resolveSenderNames(getDb(), recent);
  const now = Date.now();
  const attentionCount = summary.needsAttention;
  const nextDue = schedulesDueInRange(
    schedules.filter((s) => s.status === 'active'),
    now,
    365,
  ).slice(0, 3);
  const greeting = `${greetingFor(new Date(now), 'America/New_York')}, ${staff.name.split(' ')[0]}`;
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
        {/* The smoke reads .sh-page-title for "Overview": the title stays, the greeting is the sub-line. */}
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Overview</div>
            <div className="sh-page-sub">
              <span className="font-semibold text-foreground">{greeting}.</span> {todayLabel}
            </div>
          </div>
        </div>

        <section aria-label="Today" className="mb-6 grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Commission today" value={usd(summary.commissionToday)} icon="rates" />
          <StatTile label="Volume today" value={usd(summary.volumeToday)} icon="analytics" />
          <StatTile label="Transactions today" value={String(summary.countToday)} icon="transactions" />
          <StatTile
            label="Flagged today"
            value={String(summary.flaggedToday)}
            icon="shield"
            tone={summary.flaggedToday > 0 ? 'alert' : 'brand'}
          />
        </section>

        {attentionCount > 0 && (
          <div
            role="status"
            className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-ds-inner border border-ds-warning-border bg-ds-warning-bg px-4 py-3 text-[14px] text-ds-warning-ink"
          >
            <Icon name="warning" />
            <span>
              <strong>{attentionCount}</strong> {attentionCount === 1 ? 'transfer needs' : 'transfers need'} attention
            </span>
            <Link
              href="/admin-dashboard/compliance"
              className="ml-auto font-semibold underline underline-offset-4"
            >
              View on Compliance →
            </Link>
          </div>
        )}

        {staff.role === 'admin' && (
          <nav aria-label="Quick links" className="mb-6 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
            {QUICK_LINKS.map((q) => (
              <Link
                key={q.href}
                href={q.href}
                className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-accent"
              >
                <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent text-primary group-hover:bg-card [&_svg]:size-[17px]">
                  <Icon name={q.icon} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-foreground">{q.label}</span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">{q.sub}</span>
                </span>
              </Link>
            ))}
          </nav>
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
                <div className="font-semibold" key="r">{t.recipientName}</div>,
                <SenderCell key="sender" name={senderNames.get(senderNameKey(t.partnerId, t.phone))} phone={t.phone} partnerId={t.partnerId} />,
                <div key="a">
                  <div className="font-semibold tabular-nums">{money(t.amountSource, t.sourceCurrency)}</div>
                  {t.sourceCurrency !== 'USD' && (
                    <div className="text-xs text-muted-foreground">≈ {money(t.amountUsd, 'USD')}</div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    → {money(t.amountInr, t.destinationCurrency ?? 'INR')}
                  </div>
                </div>,
                humanizeFunding(t.fundingMethod),
                <span
                  key="s"
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap ${statusPillClass(t.status)}`}
                >
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
                <div className="font-semibold" key="r">{s.recipientName}</div>,
                <span className="font-semibold tabular-nums" key="a">{money(s.amountSource, s.sourceCurrency)}</span>,
                scheduleWhen(s),
              ],
            }))}
          />
        </Card>
      </main>
    </>
  );
}
