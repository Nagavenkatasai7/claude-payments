export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getOpsSnapshot, STUCK_PAID_MINUTES, STALE_REVIEW_HOURS, STALE_LOCK_MINUTES } from '@/lib/reconcile';
import { isEscalated } from '@/lib/stale-money';
import { emailConfigured } from '@/lib/email';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getCadenceSnapshot, cadenceRedis, DRAIN_SLA_MINUTES, CRON_QUIET_MINUTES } from '@/lib/worker-cadence';
import { WORKER_BACKSTOP_PERIOD_MIN } from '@/lib/worker-gate';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { DiagnosePanel } from './diagnose-panel';
import { approveRefundAction, dismissRefundAction, retryRefundAction } from '../actions';
import { SenderCell, FundingRefs } from '../sender-cell';
import { resolveSenderNames, senderNameKey } from '@/lib/sender-names';
import type { Transfer } from '@/lib/types';

// /admin-dashboard/ops — the money-state safety surface (Stage 5, fed by the
// Stage-2d reconciliation data). Everything here is a state the automated
// sweep has already alerted on; this page is where a human resolves it.
// PLATFORM staff only (cross-tenant by nature).

function age(iso: string | undefined | null): string {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (24 * 60))}d`;
}

/** The refundable amount is the FULL source-side charge the provider captured. */
function refundAmount(t: Transfer): string {
  return money(t.totalChargeSource ?? t.totalChargeUsd, t.sourceCurrency ?? 'USD');
}

export default async function OpsPage() {
  const { staff, scope } = await requireScope();
  if (scope.kind !== 'platform') redirect('/admin-dashboard');
  void staff;

  const snap = await getOpsSnapshot(getDb());
  // Program-Fix 12: the worker's clock. Redis failure ⇒ lastCronAt null (shown red).
  const cadence = await getCadenceSnapshot(getDb(), cadenceRedis());
  const oldestWaitMin = cadence.oldestDueAt
    ? Math.max(0, Math.round((Date.now() - cadence.oldestDueAt.getTime()) / 60_000))
    : 0;
  const drainBehind = oldestWaitMin > DRAIN_SLA_MINUTES;
  const lastCronMin = cadence.lastCronAt
    ? Math.max(0, Math.round((Date.now() - cadence.lastCronAt.getTime()) / 60_000))
    : null;
  const cronQuiet = lastCronMin === null || lastCronMin > CRON_QUIET_MINUTES;
  // Program-Fix 39: is partner email actually going out? Presence of the SMTP
  // trio only (never a value), plus how many sends were skipped this week.
  const mailConfigured = emailConfigured();
  const emailSkipped7d = await createAuditRepo(getDb()).countByAction('email.skipped', 7);
  const senderNames = await resolveSenderNames(
    getDb(),
    [
      ...snap.stuckPaid,
      ...snap.refundsRequested,
      ...snap.refundsFailed,
      ...snap.staleReviews,
    ],
  );
  const refundsTotal =
    snap.refundsRequested.length + snap.refundsPending.length + snap.refundsFailed.length;
  const healthy =
    snap.deadLetters.length === 0 &&
    snap.staleLocks.length === 0 &&
    snap.stuckPaid.length === 0 &&
    snap.staleReviews.length === 0 &&
    refundsTotal === 0 &&
    !drainBehind &&
    !cronQuiet;

  return (
    <>
      <Sidebar active="ops" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Operations</div>
            <div className="sh-page-sub">
              Stuck money states & failed effects — the reconciliation sweep alerts on these; resolve them here.
            </div>
          </div>
        </div>

        <section className="grid grid-cols-2 gap-4 lg:grid-cols-7 mb-6">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Outbox pending</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{snap.pendingOutbox}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              effects queued or retrying
            </CardContent>
          </Card>
          <Card className={snap.deadLetters.length ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Dead letters</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{snap.deadLetters.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              effects that exhausted retries
            </CardContent>
          </Card>
          <Card className={snap.staleLocks.length ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Stale locks</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{snap.staleLocks.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              lease expired &gt;{STALE_LOCK_MINUTES}m, not reclaimed — drain down?
            </CardContent>
          </Card>
          <Card className={drainBehind ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Due backlog</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{cadence.dueNow}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              claimable now · oldest {oldestWaitMin}m (SLA {DRAIN_SLA_MINUTES}m; unmarked work waits ≤{WORKER_BACKSTOP_PERIOD_MIN}m backstop)
            </CardContent>
          </Card>
          <Card className={cronQuiet ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Last cron run</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {lastCronMin === null ? 'never' : `${lastCronMin}m`}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {lastCronMin === null ? 'no marker' : 'ago'} · Vercel per-minute cron, DB only when work is due or at :17/:47 (quiet &gt;{CRON_QUIET_MINUTES}m)
            </CardContent>
          </Card>
          <Card className={snap.stuckPaid.length ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Stuck in paid</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{snap.stuckPaid.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              &gt;{STUCK_PAID_MINUTES}m without delivery confirmation
            </CardContent>
          </Card>
          <Card className={snap.staleReviews.length ? 'border-warning/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Stale reviews</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{snap.staleReviews.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              in compliance review &gt;{STALE_REVIEW_HOURS}h
            </CardContent>
          </Card>
        </section>

        {/* Program-Fix 39: email is honest — a skipped send is audited, not hidden. */}
        <Card className={`mb-6 ${!mailConfigured || emailSkipped7d > 0 ? 'border-warning/50' : ''}`}>
          <CardHeader className="pb-2">
            <CardDescription>Email</CardDescription>
            <CardTitle className="text-xl">
              {mailConfigured ? 'Configured' : 'NOT configured (partner emails are skipped)'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {emailSkipped7d} email{emailSkipped7d === 1 ? '' : 's'} skipped in the last 7 days
            (<code>email.skipped</code> audit rows). Partner lead alerts and application invites
            are skipped while SMTP_HOST / SMTP_USER / SMTP_PASS are unset.
          </CardContent>
        </Card>

        {healthy && (
          <Card className="mb-6">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              ✅ All clear — no stuck transfers, no dead effects, no backlog. The Vercel
              per-minute worker cron (hourly GitHub heartbeat as backup) and the
              reconciliation sweep are watching.
            </CardContent>
          </Card>
        )}

        {snap.deadLetters.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Dead letters</CardTitle>
              <CardDescription>
                Effects that failed {`8`} attempts. Retry re-arms the full backoff cycle; dismiss
                buries it forever (audited).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Last error</TableHead>
                    <TableHead>Age</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snap.deadLetters.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="tabular-nums">{row.id}</TableCell>
                      <TableCell><Badge variant="outline">{row.kind}</Badge></TableCell>
                      <TableCell className="max-w-[360px] truncate text-muted-foreground" title={row.lastError ?? ''}>
                        {row.lastError ?? '—'}
                      </TableCell>
                      <TableCell>{age(row.createdAt?.toISOString?.() ?? String(row.createdAt))}</TableCell>
                      <TableCell className="text-right">
                        {/* The panel owns Retry/Dismiss now — Diagnose highlights the
                            recommended one + disables Retry for permanent errors. */}
                        <DiagnosePanel subjectId={String(row.id)} kind="dead_letter" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {snap.staleLocks.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Stale locks</CardTitle>
              <CardDescription>
                Effects still marked processing more than {STALE_LOCK_MINUTES}m after their lease
                expired. The next drain reclaims them automatically — if these persist, neither the
                Vercel per-minute cron nor the GitHub heartbeat is reaching the worker.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Lease expired</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snap.staleLocks.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="tabular-nums">{row.id}</TableCell>
                      <TableCell><Badge variant="outline">{row.kind}</Badge></TableCell>
                      <TableCell className="tabular-nums">{row.attempts}</TableCell>
                      <TableCell>{age(row.leaseUntil?.toISOString())} ago</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {snap.stuckPaid.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Stuck in paid</CardTitle>
              <CardDescription>
                Charged but no delivery confirmation. Webhook-driven rails were re-instructed once
                by the sweep — chase the partner if these persist. Ops is re-alerted at 1 h / 6 h /
                24 h, then daily; the age turns red past 1 h.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transfer</TableHead>
                    <TableHead>Partner</TableHead>
                    <TableHead>Sender</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Paid</TableHead>
                    <TableHead className="text-right">Diagnose</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snap.stuckPaid.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Link href="/admin-dashboard/transactions" className="text-primary underline-offset-2 hover:underline">
                          {t.id}
                        </Link>
                      </TableCell>
                      <TableCell><Badge variant="secondary">{t.partnerId}</Badge></TableCell>
                      <TableCell><SenderCell name={senderNames.get(senderNameKey(t.partnerId, t.phone))} phone={t.phone} partnerId={t.partnerId} /></TableCell>
                      <TableCell className="tabular-nums">{money(t.amountSource, t.sourceCurrency)}</TableCell>
                      <TableCell>
                        {isEscalated(t.paidAt, Date.now())
                          ? <Badge variant="destructive">{age(t.paidAt)} ago</Badge>
                          : <>{age(t.paidAt)} ago</>}
                      </TableCell>
                      <TableCell className="text-right">
                        <DiagnosePanel subjectId={t.id} kind="stuck_transfer" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Card className="mb-6">
            <CardHeader>
              <CardTitle>Refunds</CardTitle>
              <CardDescription>
                Customer-requested refunds need a decision; failed refunds can be retried.
                In-flight refunds complete automatically (the sweep alerts if one stalls).{' '}
                <Link href="/admin-dashboard/refunds" className="underline underline-offset-2">
                  View the full refund ledger →
                </Link>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {refundsTotal === 0 && !healthy && (
                <div className="text-sm text-muted-foreground">
                  No refunds need attention right now.
                </div>
              )}
              {snap.refundsRequested.length > 0 && (
                <div>
                  <div className="mb-2 text-sm font-medium">
                    Requested <Badge variant="secondary">{snap.refundsRequested.length}</Badge>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Transfer</TableHead>
                        <TableHead>Partner</TableHead>
                        <TableHead>Sender</TableHead>
                        <TableHead>Funding</TableHead>
                        <TableHead>Refund</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snap.refundsRequested.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>{t.id}</TableCell>
                          <TableCell><Badge variant="secondary">{t.partnerId}</Badge></TableCell>
                          <TableCell><SenderCell name={senderNames.get(senderNameKey(t.partnerId, t.phone))} phone={t.phone} partnerId={t.partnerId} /></TableCell>
                          <TableCell><FundingRefs fundingMethod={t.fundingMethod} fundingRef={t.fundingRef} refundRef={t.refundRef} /></TableCell>
                          <TableCell className="tabular-nums">{refundAmount(t)}</TableCell>
                          <TableCell>{age(t.createdAt)} ago</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <form action={approveRefundAction} className="flex items-center gap-1">
                                <input type="hidden" name="id" value={t.id} />
                                <Input name="note" maxLength={500} placeholder="Note (optional)" aria-label="Note (optional)" className="h-8 w-36" />
                                <Button type="submit" size="sm" variant="default">Approve</Button>
                              </form>
                              <form action={dismissRefundAction} className="flex items-center gap-1">
                                <input type="hidden" name="id" value={t.id} />
                                <Input name="note" maxLength={500} placeholder="Note (optional)" aria-label="Note (optional)" className="h-8 w-36" />
                                <Button type="submit" size="sm" variant="outline">Dismiss</Button>
                              </form>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {snap.refundsPending.length > 0 && (
                <div className="text-sm text-muted-foreground">
                  <Badge variant="outline">{snap.refundsPending.length}</Badge>{' '}
                  refund{snap.refundsPending.length === 1 ? '' : 's'} in flight — the worker is
                  processing {snap.refundsPending.length === 1 ? 'it' : 'them'}.
                </div>
              )}
              {snap.refundsFailed.length > 0 && (
                <div>
                  <div className="mb-2 text-sm font-medium">
                    Failed <Badge variant="destructive">{snap.refundsFailed.length}</Badge>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Transfer</TableHead>
                        <TableHead>Partner</TableHead>
                        <TableHead>Sender</TableHead>
                        <TableHead>Funding</TableHead>
                        <TableHead>Refund</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {snap.refundsFailed.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>{t.id}</TableCell>
                          <TableCell><Badge variant="secondary">{t.partnerId}</Badge></TableCell>
                          <TableCell><SenderCell name={senderNames.get(senderNameKey(t.partnerId, t.phone))} phone={t.phone} partnerId={t.partnerId} /></TableCell>
                          <TableCell><FundingRefs fundingMethod={t.fundingMethod} fundingRef={t.fundingRef} refundRef={t.refundRef} /></TableCell>
                          <TableCell className="tabular-nums">{refundAmount(t)}</TableCell>
                          <TableCell>{age(t.createdAt)} ago</TableCell>
                          <TableCell className="text-right">
                            <form action={retryRefundAction} className="flex items-center gap-1">
                              <input type="hidden" name="id" value={t.id} />
                              <Input name="note" maxLength={500} placeholder="Note (optional)" aria-label="Note (optional)" className="h-8 w-36" />
                              <Button type="submit" size="sm" variant="default">Retry</Button>
                            </form>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

        {snap.staleReviews.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Stale compliance reviews</CardTitle>
              <CardDescription>
                Held &gt;{STALE_REVIEW_HOURS}h — release or refund on the Compliance page.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transfer</TableHead>
                    <TableHead>Partner</TableHead>
                    <TableHead>Sender</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Held since</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snap.staleReviews.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>{t.id}</TableCell>
                      <TableCell><Badge variant="secondary">{t.partnerId}</Badge></TableCell>
                      <TableCell><SenderCell name={senderNames.get(senderNameKey(t.partnerId, t.phone))} phone={t.phone} partnerId={t.partnerId} /></TableCell>
                      <TableCell className="tabular-nums">{money(t.amountSource, t.sourceCurrency)}</TableCell>
                      <TableCell>{age(t.paidAt)} ago</TableCell>
                      <TableCell className="text-right">
                        <Button asChild size="sm" variant="outline">
                          <Link href="/admin-dashboard/compliance">Review →</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}
