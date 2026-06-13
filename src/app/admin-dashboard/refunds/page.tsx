export const dynamic = 'force-dynamic';

import { requireScope } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { Sidebar } from '../sidebar';
import { money } from '../format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { approveRefundAction, dismissRefundAction, retryRefundAction } from '../actions';
import type { RefundStatus, Transfer } from '@/lib/types';

// /admin-dashboard/refunds — the always-on refund ledger. Unlike the Operations
// page (platform-only, shows only refunds that NEED a decision), this surface is
// discoverable for every staff member, scoped to their tenant, and shows the
// FULL lifecycle including completed refunds — so an admin always has a refund
// view, even when the actionable queue is empty.

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

const REFUND_BADGE: Record<Exclude<RefundStatus, 'none'>, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  requested: { label: 'Requested', variant: 'secondary' },
  pending: { label: 'In flight', variant: 'outline' },
  completed: { label: 'Refunded', variant: 'default' },
  failed: { label: 'Failed', variant: 'destructive' },
};

export default async function RefundsPage() {
  const { staff, scope } = await requireScope();
  // Refund actions (approve/dismiss/retry) are admin-only server-side; only admins
  // get the live buttons, so non-admin staff aren't shown controls that bounce.
  const isAdmin = staff.role === 'admin';
  const partnerId = scope.kind === 'partner' ? scope.partnerId : undefined;

  const all = await createTransferRepo(getDb()).listActiveRefunds({ partnerId });

  const counts = {
    requested: all.filter((t) => t.refundStatus === 'requested').length,
    pending: all.filter((t) => t.refundStatus === 'pending').length,
    completed: all.filter((t) => t.refundStatus === 'completed').length,
    failed: all.filter((t) => t.refundStatus === 'failed').length,
  };

  return (
    <>
      <Sidebar active="refunds" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Refunds</div>
            <div className="sh-page-sub">
              Every refund and its lifecycle. Customer-requested refunds need a decision;
              failed refunds can be retried; refunds in flight complete automatically.
            </div>
          </div>
        </div>

        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-6">
          <Card className={counts.requested ? 'border-warning/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Awaiting decision</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{counts.requested}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">customer-requested</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>In flight</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{counts.pending}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">the worker is processing</CardContent>
          </Card>
          <Card className={counts.failed ? 'border-destructive/50' : ''}>
            <CardHeader className="pb-2">
              <CardDescription>Failed</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{counts.failed}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">retry from the table</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Refunded</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{counts.completed}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">money returned</CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>All refunds</CardTitle>
            <CardDescription>
              {all.length === 0
                ? 'No refunds yet. When a customer requests one — or an admin issues one from a transaction — it appears here.'
                : `${all.length} refund${all.length === 1 ? '' : 's'} across all states, newest first.`}
            </CardDescription>
          </CardHeader>
          {all.length > 0 && (
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transfer</TableHead>
                    <TableHead>Partner</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {all.map((t) => {
                    const rs = (t.refundStatus ?? 'none') as Exclude<RefundStatus, 'none'>;
                    const badge = REFUND_BADGE[rs];
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="font-mono text-xs">{t.id}</TableCell>
                        <TableCell><Badge variant="secondary">{t.partnerId}</Badge></TableCell>
                        <TableCell className="tabular-nums">{refundAmount(t)}</TableCell>
                        <TableCell>{badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : rs}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {t.refundRef ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {t.refundStatus === 'completed' && t.refundedAt
                            ? `${age(t.refundedAt)} ago`
                            : `${age(t.createdAt)} ago`}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {isAdmin && t.refundStatus === 'requested' && (
                              <>
                                <form action={approveRefundAction}>
                                  <input type="hidden" name="id" value={t.id} />
                                  <Button type="submit" size="sm" variant="default">Approve</Button>
                                </form>
                                <form action={dismissRefundAction}>
                                  <input type="hidden" name="id" value={t.id} />
                                  <Button type="submit" size="sm" variant="outline">Dismiss</Button>
                                </form>
                              </>
                            )}
                            {isAdmin && t.refundStatus === 'failed' && (
                              <form action={retryRefundAction}>
                                <input type="hidden" name="id" value={t.id} />
                                <Button type="submit" size="sm" variant="default">Retry</Button>
                              </form>
                            )}
                            {/* Non-admins (and pending/completed rows) see a read-only status word, not dead buttons. */}
                            {(!isAdmin || t.refundStatus === 'pending' || t.refundStatus === 'completed') && (
                              <span className="text-xs text-muted-foreground">
                                {t.refundStatus === 'pending' ? 'processing…'
                                  : t.refundStatus === 'completed' ? 'done'
                                  : t.refundStatus === 'requested' ? 'awaiting admin'
                                  : t.refundStatus === 'failed' ? 'needs admin retry'
                                  : '—'}
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          )}
        </Card>
      </main>
    </>
  );
}
