export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getOpsSnapshot, STUCK_PAID_MINUTES, STALE_REVIEW_HOURS } from '@/lib/reconcile';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { retryDeadAction, dismissDeadAction } from './actions';

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

export default async function OpsPage() {
  const { staff, scope } = await requireScope();
  if (scope.kind !== 'platform') redirect('/admin-dashboard');
  void staff;

  const snap = await getOpsSnapshot(getDb());
  const healthy =
    snap.deadLetters.length === 0 && snap.stuckPaid.length === 0 && snap.staleReviews.length === 0;

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

        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-6">
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

        {healthy && (
          <Card className="mb-6">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              ✅ All clear — no stuck transfers, no dead effects. The worker heartbeat and
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
                        <div className="flex justify-end gap-2">
                          <form action={retryDeadAction}>
                            <input type="hidden" name="id" value={row.id} />
                            <Button type="submit" size="sm" variant="default">Retry</Button>
                          </form>
                          <form action={dismissDeadAction}>
                            <input type="hidden" name="id" value={row.id} />
                            <Button type="submit" size="sm" variant="outline">Dismiss</Button>
                          </form>
                        </div>
                      </TableCell>
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
                by the sweep — chase the partner if these persist.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transfer</TableHead>
                    <TableHead>Partner</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Paid</TableHead>
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
                      <TableCell className="tabular-nums">{money(t.amountSource, t.sourceCurrency)}</TableCell>
                      <TableCell>{age(t.paidAt)} ago</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

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
