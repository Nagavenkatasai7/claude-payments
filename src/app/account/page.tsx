import { Suspense } from 'react';
import Link from 'next/link';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { requireCustomer } from '@/lib/customer-auth';
import { sendGateActive } from '@/lib/kyc-gate';
import { getPartnerStore } from '@/lib/partner-store';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import {
  getCustomerSummary,
  buildSummaryContext,
  buildDeterministicSummary,
} from '@/lib/customer-summary';
import { maskAccount } from '@/lib/tools';
import { easternMonth } from '@/lib/dates';
import { waLink, WA_MESSAGES } from '@/app/landing/wa';
import type { Transfer } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AccountShell, PageHeader, StatCard } from './shell';
import { SpendingTrend } from './overview-chart';
import {
  maskPhone,
  money,
  transferAmount,
  transferStatusLabel,
  transferStatusTone,
} from './format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your account · SmartRemit' };

const WA_HREF = waLink(WA_MESSAGES.generic);

/**
 * USD-equivalent amount of a transfer, for the cross-currency monthly trend.
 * Only money that actually left the customer counts toward "sent" — pending,
 * cancelled, blocked, and awaiting-payment transfers are excluded so the
 * "Sent this month" total never inflates beyond what was really sent.
 */
function sentUsd(t: Transfer): number {
  if (t.status !== 'paid' && t.status !== 'delivered') return 0;
  return t.amountUsd ?? t.amountSource ?? 0;
}

/**
 * Last 6 calendar months of send volume (USD-equiv), oldest → newest. Buckets
 * by EASTERN month (easternMonth) — the same basis as the admin analytics — so
 * a late-evening send near a month boundary lands in the same month everywhere.
 */
function monthlyBuckets(
  transfers: Transfer[],
  now: Date,
): { key: string; month: string; volumeUsd: number }[] {
  const buckets: { key: string; month: string; volumeUsd: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: easternMonth(d.getTime()),
      month: d.toLocaleDateString('en-US', { month: 'short' }),
      volumeUsd: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const t of transfers) {
    const bucket = byKey.get(easternMonth(Date.parse(t.createdAt)));
    if (bucket) bucket.volumeUsd += sentUsd(t);
  }
  return buckets.map((b) => ({ ...b, volumeUsd: Math.round(b.volumeUsd * 100) / 100 }));
}

/**
 * Smart-summary card — streamed in behind <Suspense> so a cold cache never
 * blocks the page shell. The AI path (getCustomerSummary) returns null on ANY
 * model/cache failure; rather than leave the slot silently empty we then fall
 * back to a DETERMINISTIC digest built purely from the customer's own data
 * (buildDeterministicSummary). The "AI-generated" disclaimer is shown ONLY on
 * the real-AI path — the deterministic card never claims to be AI.
 */
async function SmartSummaryCard({ phone }: { phone: string }) {
  const summary = await getCustomerSummary(phone);
  if (summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm leading-relaxed text-foreground">{summary}</p>
          <p className="text-xs text-muted-foreground">
            AI-generated — check your history for official status.
          </p>
        </CardContent>
      </Card>
    );
  }

  // AI path unavailable — build the same SummaryContext the model would have
  // seen (the customer's OWN masked facts only) and render it deterministically.
  // Any failure here too just drops the card, exactly as before.
  let fallback: string | null = null;
  try {
    const store = getStore();
    const [customer, transfers, todayUsedCents] = await Promise.all([
      getCustomerStore(store).getCustomer(phone),
      store.listTransfersByPhone(phone, 5),
      getDailyVolumeStore().getTodayCents(phone),
    ]);
    if (customer) {
      const partnerRow = await getPartnerStore().getPartner(customer.partnerId);
      const partner = partnerRow ?? (await getPartnerStore().ensureDefaultPartner());
      const context = buildSummaryContext(
        customer,
        transfers,
        todayUsedCents,
        sendGateActive(partner),
      );
      fallback = buildDeterministicSummary(context);
    }
  } catch {
    fallback = null;
  }
  if (!fallback) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm leading-relaxed text-foreground">{fallback}</p>
        <p className="text-xs text-muted-foreground">
          Based on your account activity — check your history for official status.
        </p>
      </CardContent>
    </Card>
  );
}

function SummarySkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader>
        <CardTitle className="text-base">Your summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </CardContent>
    </Card>
  );
}

export default async function AccountHomePage() {
  const customer = await requireCustomer();

  // KYC is partner OPT-IN (sendGateActive) — the customer's partner ROW decides
  // whether the verification card exists at all. Gate off ⇒ no card; the verify
  // page + its server action enforce the same gate. We load a deeper transfer
  // window (for the 6-month trend + this-month sum) plus today's used cents +
  // the saved recipients in one fan-out.
  const store = getStore();
  const [partnerRow, transfers, todayUsedCents, recipients] = await Promise.all([
    getPartnerStore().getPartner(customer.partnerId),
    store.listTransfersByPhone(customer.senderPhone, 200),
    getDailyVolumeStore().getTodayCents(customer.senderPhone),
    store.listRecipients(customer.senderPhone, 6),
  ]);
  const partner = partnerRow ?? (await getPartnerStore().ensureDefaultPartner());
  const gateActive = sendGateActive(partner);
  const verified = customer.kycStatus === 'verified';
  const showVerifyCta = gateActive && !verified;

  // Stats — all derived from the (already-masked, customer-owned) transfer list
  // plus the same cap composition the bot's check_send_limit uses. The current
  // month's total is simply the last (newest) trend bucket — no second scan.
  const now = new Date();
  const cap = buildSummaryContext(customer, transfers, todayUsedCents, gateActive);
  const buckets = monthlyBuckets(transfers, now);
  const monthSentUsd = buckets[buckets.length - 1].volumeUsd;
  const pendingRefunds = transfers.filter(
    (t) => t.refundStatus === 'requested' || t.refundStatus === 'pending',
  ).length;
  const hasVolume = buckets.some((b) => b.volumeUsd > 0);
  const recent = transfers.slice(0, 6);

  return (
    <AccountShell active="overview" customer={customer}>
      <PageHeader
        title="Welcome back"
        sub={`Signed in as ${maskPhone(customer.senderPhone)}`}
        actions={
          gateActive && verified ? (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="size-3" /> Verified
            </Badge>
          ) : undefined
        }
      />

      {/* Identity verification — only when the partner gate is on AND unverified. */}
      {showVerifyCta ? (
        <Alert className="mb-6">
          <ShieldCheck />
          <AlertTitle>Verify your identity</AlertTitle>
          <AlertDescription className="flex flex-col gap-3">
            <span>
              Takes about 2 minutes on our secure partner&rsquo;s page — then you can
              send money in WhatsApp.
            </span>
            <Button asChild size="sm" className="w-fit">
              <Link href="/account/verify">Verify now</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Stat row */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Sent this month"
          value={money(monthSentUsd, 'USD')}
          sub="USD equivalent"
        />
        <StatCard
          label="Daily limit left"
          value={money(cap.dailyRemainingUsd, 'USD')}
          sub={`of ${money(cap.dailyLimitUsd, 'USD')}`}
        />
        <StatCard label="Transfers" value={transfers.length} sub="all time" />
        <StatCard label="Pending refunds" value={pendingRefunds} sub="in progress" />
      </div>

      {/* Primary actions */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Button asChild size="lg">
          <a href={WA_HREF} target="_blank" rel="noopener noreferrer">
            Send money
          </a>
        </Button>
        <Button asChild variant="ghost" size="lg">
          <Link href="/account/chat">AI assistant</Link>
        </Button>
        <Button asChild variant="ghost" size="lg">
          <Link href="/account/support">Support</Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Spending trend + recent transfers (main column) */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Spending trend</CardTitle>
            </CardHeader>
            <CardContent>
              {hasVolume ? (
                <SpendingTrend data={buckets} />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No transfers in the last 6 months yet.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Recent transfers</CardTitle>
              <Button asChild variant="link" size="sm" className="h-auto p-0">
                <Link href="/account/history">View all</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No transfers yet — message us on WhatsApp to send your first one.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Recipient</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recent.map((t) => (
                      // One Link per row (a single tab stop) stretched over the
                      // whole row via the ::after overlay; the rest of the cells
                      // are plain text. Matches the history page's whole-row link.
                      <TableRow key={t.id} className="relative cursor-pointer">
                        <TableCell className="text-muted-foreground">
                          <Link
                            href={`/account/receipt/${t.id}`}
                            aria-label={`View receipt for transfer to ${t.recipientName}`}
                            className="font-normal after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                          >
                            {new Date(t.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </Link>
                        </TableCell>
                        <TableCell className="font-medium">{t.recipientName}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {transferAmount(t)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant={transferStatusTone(t)}>
                            {transferStatusLabel(t)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Side column: saved recipients + AI summary */}
        <div className="space-y-6">
          {recipients.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Saved recipients</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {recipients.map((r) => (
                  <div
                    key={r.recipientPhone}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {r.name}
                      </div>
                      <div className="truncate text-xs tabular-nums text-muted-foreground">
                        {maskAccount(r.payoutMethod, r.payoutDestination)}
                      </div>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <a href={WA_HREF} target="_blank" rel="noopener noreferrer">
                        Send again
                      </a>
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Suspense fallback={<SummarySkeleton />}>
            <SmartSummaryCard phone={customer.senderPhone} />
          </Suspense>
        </div>
      </div>
    </AccountShell>
  );
}
