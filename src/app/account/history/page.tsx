export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { formatDestAmount } from '@/lib/payment';

export const metadata = { title: 'Transfer history · SmartRemit' };

// /account/history — the customer's OWN transfers (Stage 5d). Ownership is
// structural: the query is WHERE phone = <session phone> (indexed), and the
// default ledger read masks payout destinations, so nothing here can leak
// another customer's data or a full account number.

const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Awaiting payment',
  paid: 'Processing',
  delivered: 'Delivered ✓',
  cancelled: 'Cancelled',
  in_review: 'Under review',
  blocked: 'On hold',
};

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export default async function AccountHistoryPage() {
  const customer = await requireCustomer();
  const transfers = await getStore().listTransfersByPhone(customer.senderPhone, 50);

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SmartRemit</div>
        <h1>Transfer history</h1>
        {transfers.length === 0 ? (
          <p className="acct-sub">
            No transfers yet — message us on WhatsApp to send your first one.
          </p>
        ) : (
          <>
            <p className="acct-sub" style={{ marginBottom: 14 }}>
              Your latest {transfers.length} {transfers.length === 1 ? 'transfer' : 'transfers'},
              newest first. Tap one for the receipt.
            </p>
            {transfers.map((t) => (
              <Link
                key={t.id}
                href={`/account/receipt/${t.id}`}
                className="summary"
                style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
              >
                <div className="row">
                  <span style={{ fontWeight: 600 }}>{t.recipientName}</span>
                  <span>{money(t.amountSource ?? t.amountUsd, t.sourceCurrency ?? 'USD')}</span>
                </div>
                <div className="row" style={{ opacity: 0.75 }}>
                  <span>{new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  <span>{STATUS_LABEL[t.status] ?? t.status}</span>
                </div>
                <div className="row" style={{ opacity: 0.6, fontSize: 12 }}>
                  <span>→ {formatDestAmount(t.amountInr, t.destinationCurrency ?? 'INR')}</span>
                  <span>Receipt →</span>
                </div>
              </Link>
            ))}
          </>
        )}
        <p style={{ marginTop: 16 }}>
          <Link href="/account" className="acct-sub" style={{ textDecoration: 'underline' }}>
            ← Back to your account
          </Link>
        </p>
      </div>
    </main>
  );
}
