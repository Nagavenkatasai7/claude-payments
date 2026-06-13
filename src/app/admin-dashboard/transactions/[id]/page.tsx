export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
import { Sidebar } from '../../sidebar';
import { money } from '../../format';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { issueRefundAction } from '../../actions';
import { RefundConfirmButton } from '../refund-confirm-button';
import type { RefundStatus } from '@/lib/types';

// /admin-dashboard/transactions/[id] — read-only single-transfer detail. Surfaces
// fields the list can't: which partner WON the best-rate routing and settled the
// transfer (settlementPartnerId), the funding charge reference (fundingRef), and
// the refund lifecycle. The ONLY mutation here is the admin "Issue refund"
// action, scope- and role-guarded server-side. Masked reads only — the audited
// reveal path is never invoked here.

const REFUND_BADGE: Record<Exclude<RefundStatus, 'none'>, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  requested: { label: 'Refund requested', variant: 'secondary' },
  pending: { label: 'Refund in flight', variant: 'outline' },
  completed: { label: 'Refunded', variant: 'default' },
  failed: { label: 'Refund failed', variant: 'destructive' },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { staff: viewer } = await requireScope();
  const scoped = createScopedStore(viewer);

  // 404-never-403: an out-of-scope id is indistinguishable from a missing one.
  const t = await scoped.getTransfer(id);
  if (!t) notFound();

  const [owningPartner, settlingPartner] = await Promise.all([
    scoped.getPartner(t.partnerId),
    t.settlementPartnerId ? scoped.getPartner(t.settlementPartnerId) : Promise.resolve(null),
  ]);
  const routed = !!t.settlementPartnerId && t.settlementPartnerId !== t.partnerId;
  const charged = !!t.fundingRef;
  const refundStatus = (t.refundStatus ?? 'none') as RefundStatus;
  const refundBadge = refundStatus !== 'none' ? REFUND_BADGE[refundStatus] : null;

  const canIssueRefund =
    viewer.role === 'admin' &&
    charged &&
    refundStatus === 'none' &&
    (t.status === 'paid' || t.status === 'delivered');

  const refundAmount = money(t.totalChargeSource ?? t.totalChargeUsd, t.sourceCurrency ?? 'USD');

  return (
    <>
      <Sidebar active="transactions" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Transfer {t.id}</div>
            <div className="sh-page-sub">
              <Link href="/admin-dashboard/transactions" className="underline underline-offset-2">
                ← Back to transactions
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{t.status}</Badge>
            {refundBadge && <Badge variant={refundBadge.variant}>{refundBadge.label}</Badge>}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Transfer</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <Field label="Sender charge">
                <span className="tabular-nums">{refundAmount}</span>
              </Field>
              <Field label="Recipient gets">
                <span className="tabular-nums">
                  {money(t.amountInr, t.destinationCurrency ?? 'INR')}
                </span>
              </Field>
              <Field label="Recipient">{t.recipientName}</Field>
              <Field label="Payout destination">
                <span className="font-mono text-xs">{t.payoutDestination}</span>
              </Field>
              <Field label="Created">{new Date(t.createdAt).toLocaleString()}</Field>
              <Field label="Owning partner">
                {owningPartner?.name ?? t.partnerId}
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Routing &amp; funding</CardTitle>
              <CardDescription>Where the money was routed and charged.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <Field label="Settled via">
                {routed ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Badge variant="default">{settlingPartner?.name ?? t.settlementPartnerId}</Badge>
                    <span className="text-xs text-muted-foreground">best-rate winner</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Owning partner (no routing)</span>
                )}
              </Field>
              <Field label="Funding">
                {charged ? (
                  <Badge variant="default">Charged</Badge>
                ) : (
                  <Badge variant="outline">Uncharged</Badge>
                )}
              </Field>
              <Field label="Charge reference">
                <span className="font-mono text-xs text-muted-foreground">{t.fundingRef ?? '—'}</span>
              </Field>
              <Field label="Refund">
                {refundBadge ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Badge variant={refundBadge.variant}>{refundBadge.label}</Badge>
                    {t.refundRef && <span className="font-mono text-xs text-muted-foreground">{t.refundRef}</span>}
                  </span>
                ) : (
                  <span className="text-muted-foreground">No refund</span>
                )}
              </Field>
            </CardContent>
          </Card>
        </div>

        {viewer.role === 'admin' && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Refund</CardTitle>
              <CardDescription>
                Return the sender&apos;s charge. Refunding a delivered transfer is a clawback you
                settle with the partner out-of-band; the customer is notified automatically.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canIssueRefund ? (
                <div className="flex items-center gap-3">
                  <RefundConfirmButton
                    action={issueRefundAction}
                    transferId={t.id}
                    confirmText={
                      t.status === 'delivered'
                        ? `Issue a refund for ${t.id}? This transfer was already DELIVERED — refunding it is a clawback of ${refundAmount}.`
                        : `Issue a refund for ${t.id}? This returns the ${refundAmount} charge to the customer.`
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {t.status === 'delivered'
                      ? 'This transfer was delivered — refund is a clawback.'
                      : 'This transfer is paid but not yet delivered.'}
                  </span>
                </div>
              ) : refundStatus !== 'none' ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    A refund is already {refundBadge?.label.toLowerCase() ?? refundStatus}
                    {t.refundRef ? ` (${t.refundRef})` : ''}.
                  </span>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admin-dashboard/refunds">Manage in the refund ledger →</Link>
                  </Button>
                </div>
              ) : !charged ? (
                <p className="text-sm text-muted-foreground">
                  This transfer was never charged, so there is nothing to refund.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This transfer is {t.status} — only paid or delivered transfers can be refunded.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {viewer.role !== 'admin' && refundStatus !== 'none' && (
          <div className="mt-6">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin-dashboard/refunds">View the refund ledger</Link>
            </Button>
          </div>
        )}
      </main>
    </>
  );
}
