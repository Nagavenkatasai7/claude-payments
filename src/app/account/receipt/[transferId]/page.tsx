export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { formatDestAmount } from '@/lib/payment';

export const metadata = { title: 'Receipt · SmartRemit' };

// /account/receipt/[transferId] — ownership-checked receipt (Stage 5d).
// 404-never-403: a transfer that isn't the signed-in customer's own is
// indistinguishable from one that doesn't exist. The default ledger read is
// MASKED (****last4) — the full account number never renders here.

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Awaiting payment',
  paid: 'Payment received — delivering',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  in_review: 'Under review',
  blocked: 'On hold',
};

function fmtWhen(iso?: string): string {
  return iso
    ? new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : '—';
}

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ transferId: string }>;
}) {
  const customer = await requireCustomer();
  const { transferId } = await params;
  const t = await getStore().getTransfer(transferId);
  if (!t || t.phone !== customer.senderPhone) notFound();

  const srcCurrency = t.sourceCurrency ?? 'USD';

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SmartRemit</div>
        <h1>Transfer receipt</h1>

        <div className="summary">
          <div className="row">
            <span>Status</span>
            <span style={{ fontWeight: 600 }}>{STATUS_LABEL[t.status] ?? t.status}</span>
          </div>
          <div className="row"><span>Transfer ID</span><span style={{ fontFamily: 'monospace', fontSize: 13 }}>{t.id}</span></div>
          <div className="row"><span>Created</span><span>{fmtWhen(t.createdAt)}</span></div>
          {t.paidAt && <div className="row"><span>Paid</span><span>{fmtWhen(t.paidAt)}</span></div>}
          {t.deliveredAt && <div className="row"><span>Delivered</span><span>{fmtWhen(t.deliveredAt)}</span></div>}
        </div>

        <div className="summary">
          <div className="row"><span>To</span><span style={{ fontWeight: 600 }}>{t.recipientName}</span></div>
          <div className="row">
            <span>Account</span>
            <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
              {t.payoutMethod.toUpperCase()} · {t.payoutDestination || '—'}
            </span>
          </div>
          <div className="row">
            <span>They receive</span>
            <span style={{ fontWeight: 600 }}>{formatDestAmount(t.amountInr, t.destinationCurrency ?? 'INR')}</span>
          </div>
        </div>

        <div className="summary">
          <div className="row"><span>You send</span><span>{money(t.amountSource ?? t.amountUsd, srcCurrency)}</span></div>
          <div className="row"><span>Fee</span><span>{money(t.feeSource ?? t.feeUsd, srcCurrency)}</span></div>
          <div className="row" style={{ fontWeight: 600 }}>
            <span>Total charged</span>
            <span>{money(t.totalChargeSource ?? t.totalChargeUsd, srcCurrency)}</span>
          </div>
          <div className="row" style={{ opacity: 0.75 }}>
            <span>Exchange rate</span>
            <span>1 {srcCurrency} = {t.fxRate} {t.destinationCurrency ?? 'INR'}</span>
          </div>
        </div>

        <p className="acct-sub" style={{ fontSize: 12 }}>
          Rate locked when you confirmed. Questions? Reply to us on WhatsApp with this transfer ID.
        </p>
        <p style={{ marginTop: 12 }}>
          <Link href="/account/history" className="acct-sub" style={{ textDecoration: 'underline' }}>
            ← All transfers
          </Link>
        </p>
      </div>
    </main>
  );
}
