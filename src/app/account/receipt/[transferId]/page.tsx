export const dynamic = 'force-dynamic';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { formatDestAmount } from '@/lib/payment';
import { isRecallEligible } from '@/lib/refund-policy';
import { AccountShell, PageHeader } from '../../shell';
import { money, transferAmount, transferStatusLabel, transferStatusTone } from '../../format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { requestRefundAction } from '../refund-actions';
import { requestRecallAction } from '../recall-actions';

export const metadata = { title: 'Receipt · SmartRemit' };

// /account/receipt/[transferId] — ownership-checked receipt.
// 404-never-403: a transfer that isn't the signed-in customer's own is
// indistinguishable from one that doesn't exist. The default ledger read is
// MASKED (****last4) — the full account number never renders here.

// Recall/dispute reasons offered on a delivered transfer (mirror the action's
// enum exactly). The server action re-validates the chosen value.
const RECALL_REASONS: { value: string; label: string }[] = [
  { value: 'not_received', label: 'The money never arrived' },
  { value: 'wrong_recipient', label: 'Sent to the wrong recipient' },
  { value: 'wrong_amount', label: 'Wrong amount sent' },
  { value: 'unauthorized', label: "I didn't authorize this transfer" },
  { value: 'other', label: 'Something else' },
];

// Friendly messages for the redirect-with-code refusals the recall action emits.
const RECALL_ERROR_MSG: Record<string, string> = {
  reason: 'Please choose what went wrong before reporting a problem.',
  ineligible: 'This transfer can no longer be reported here — please message us on WhatsApp.',
  cap: 'You already have 5 open requests. Reply on one of those, or wait for one to be resolved first.',
};

// A short, human one-liner under the status pill, by current state.
const STATUS_SUMMARY: Record<string, string> = {
  awaiting_payment: 'Waiting for payment to clear.',
  paid: 'Payment received — your transfer is on its way.',
  delivered: 'The money has been delivered to your recipient.',
  cancelled: 'This transfer was cancelled.',
  in_review: 'This transfer is being reviewed. We will be in touch shortly.',
  blocked: 'This transfer could not be completed and you were not charged.',
};

function fmtWhen(iso?: string): string {
  return iso
    ? new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : '—';
}

/** One label/value row inside a definition-list-style Card. */
function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? 'font-semibold text-foreground' : 'text-foreground'}`}>
        {value}
      </dd>
    </div>
  );
}

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ transferId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const customer = await requireCustomer();
  const { transferId } = await params;
  const { error } = await searchParams;
  const t = await getStore().getTransfer(transferId);
  if (!t || t.phone !== customer.senderPhone) notFound();

  const srcCurrency = t.sourceCurrency ?? 'USD';
  const destCurrency = t.destinationCurrency ?? 'INR';

  // Customer-facing refund request — eligible ONLY when the transfer is paid
  // (a paid transfer is by definition not yet delivered — status is one value)
  // and no refund is in flight. The server action re-checks all of this (the
  // page render is never authoritative); this just gates the CTA.
  const refundStatus = t.refundStatus ?? 'none';
  const canRequestRefund = t.status === 'paid' && refundStatus === 'none';

  // Customer-facing recall/dispute — once money is DELIVERED there's no refund
  // path, but a delivered transfer inside the 24h recall window may open a
  // support ticket. The server action re-checks eligibility (this only gates the
  // CTA). refundDisposition already requires refundStatus 'none', so this never
  // collides with the refund block above.
  const canRecall = isRecallEligible(t, Date.now());
  const recallErrorMsg = error ? RECALL_ERROR_MSG[error] : undefined;

  const statusSummary = STATUS_SUMMARY[t.status] ?? 'In progress.';

  return (
    <AccountShell active="transfers" customer={customer}>
      <PageHeader
        title="Receipt"
        sub={<>Transfer <span className="font-mono">#{t.id}</span></>}
        actions={
          <Button asChild variant="outline">
            <Link href="/account/history">Back</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Status summary */}
        <Card className="sm:col-span-2">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <Badge variant={transferStatusTone(t)}>{transferStatusLabel(t)}</Badge>
              <p className="mt-2 text-sm text-muted-foreground">{statusSummary}</p>
              {t.refundStatus === 'completed' && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Refunded to your original payment method
                  {t.refundedAt ? ` on ${fmtWhen(t.refundedAt)}` : ''}.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Amount breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="You send" value={transferAmount(t)} />
              <Row label="Fee" value={money(t.feeSource ?? t.feeUsd, srcCurrency)} />
              <Separator className="my-1" />
              <Row
                label="Total charged"
                value={money(t.totalChargeSource ?? t.totalChargeUsd, srcCurrency)}
                strong
              />
              <Row label="Rate" value={`1 ${srcCurrency} = ${t.fxRate} ${destCurrency}`} />
              <Row
                label="Recipient gets"
                value={formatDestAmount(t.amountInr, destCurrency)}
                strong
              />
            </dl>
          </CardContent>
        </Card>

        {/* Recipient + timeline */}
        <Card>
          <CardHeader>
            <CardTitle>Recipient</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="To" value={<span className="font-medium">{t.recipientName}</span>} />
              <Row
                label="Account"
                value={
                  <span className="font-mono text-xs">
                    {t.payoutMethod.toUpperCase()} · {t.payoutDestination || '—'}
                  </span>
                }
              />
              <Separator className="my-1" />
              <Row label="Created" value={fmtWhen(t.createdAt)} />
              {t.paidAt && <Row label="Paid" value={fmtWhen(t.paidAt)} />}
              {t.deliveredAt && <Row label="Delivered" value={fmtWhen(t.deliveredAt)} />}
            </dl>
          </CardContent>
        </Card>

        {/* Request a refund — only on a paid transfer with no refund in flight. */}
        {canRequestRefund && (
          <Card className="sm:col-span-2">
            <CardHeader>
              <CardTitle>Request a refund</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={requestRefundAction} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="max-w-prose text-sm text-muted-foreground">
                  Our team reviews every refund request — refunds arrive in 3–5 business days
                  once approved.
                </p>
                <input type="hidden" name="transferId" value={t.id} />
                <Button type="submit" variant="outline" className="shrink-0">
                  Request a refund
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Report a problem — delivered transfer inside the 24h recall window. */}
        {canRecall && (
          <Card className="sm:col-span-2">
            <CardHeader>
              <CardTitle>Report a problem with this transfer</CardTitle>
            </CardHeader>
            <CardContent>
              {recallErrorMsg ? (
                <Alert variant="destructive" className="mb-4">
                  <AlertTitle>We couldn&rsquo;t report that</AlertTitle>
                  <AlertDescription>{recallErrorMsg}</AlertDescription>
                </Alert>
              ) : null}
              <form action={requestRecallAction} className="flex flex-col gap-4">
                <input type="hidden" name="transferId" value={t.id} />
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="recall-reason" className="text-sm font-medium text-foreground">
                    What went wrong?
                  </label>
                  {/* Native select keeps this a plain server-action POST (no client
                      island). text-base avoids iOS Safari auto-zoom on focus. */}
                  <select
                    id="recall-reason"
                    name="reason"
                    defaultValue=""
                    required
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
                  >
                    <option value="" disabled>
                      Choose a reason…
                    </option>
                    {RECALL_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="max-w-prose text-sm text-muted-foreground">
                    Once money is delivered we can&rsquo;t guarantee recovery, but our team will
                    look into it.
                  </p>
                  <Button type="submit" variant="destructive" className="shrink-0">
                    Report a problem
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Rate locked when you confirmed. Questions? Reply to us on WhatsApp with this transfer ID.
      </p>
    </AccountShell>
  );
}
