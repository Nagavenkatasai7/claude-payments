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

const rowCls = 'flex justify-between py-1.5 text-sm leading-normal';

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
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">Transfer history</h1>
        {transfers.length === 0 ? (
          <p className="-mt-2 mb-5 text-sm leading-normal text-[#8696a0]">
            No transfers yet — message us on WhatsApp to send your first one.
          </p>
        ) : (
          <>
            <p className="-mt-2 mb-3.5 text-sm leading-normal text-[#8696a0]">
              Your latest {transfers.length} {transfers.length === 1 ? 'transfer' : 'transfers'},
              newest first. Tap one for the receipt.
            </p>
            {transfers.map((t) => (
              <Link
                key={t.id}
                href={`/account/receipt/${t.id}`}
                className="mb-5 block rounded-xl bg-[#202c33] p-3.5 text-inherit no-underline"
              >
                <div className={rowCls}>
                  <span className="font-semibold text-[#8696a0]">{t.recipientName}</span>
                  <span>{money(t.amountSource ?? t.amountUsd, t.sourceCurrency ?? 'USD')}</span>
                </div>
                <div className={`${rowCls} opacity-75`}>
                  <span className="text-[#8696a0]">{new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  <span>{STATUS_LABEL[t.status] ?? t.status}</span>
                </div>
                <div className="flex justify-between py-1.5 text-[12px] leading-normal opacity-60">
                  <span className="text-[#8696a0]">→ {formatDestAmount(t.amountInr, t.destinationCurrency ?? 'INR')}</span>
                  <span>Receipt →</span>
                </div>
              </Link>
            ))}
          </>
        )}
        <p className="mt-4">
          <Link href="/account" className="text-sm text-[#8696a0] underline">
            ← Back to your account
          </Link>
        </p>
      </div>
    </main>
  );
}
