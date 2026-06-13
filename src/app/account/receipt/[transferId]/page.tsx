export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { formatDestAmount } from '@/lib/payment';
import { requestRefundAction } from '../refund-actions';

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
  blocked: 'Could not be completed',
};

// Refund-aware overlay: an active or settled refund replaces the base label.
// 'failed' deliberately falls through to the base status — a failed refund
// attempt is ops-internal; the customer keeps seeing the prior state.
const REFUND_LABEL: Record<string, string> = {
  requested: 'Refund requested',
  pending: 'Refund on the way',
  completed: 'Refunded',
};

function statusLabel(t: { status: string; refundStatus?: string }): string {
  return REFUND_LABEL[t.refundStatus ?? ''] ?? STATUS_LABEL[t.status] ?? t.status;
}

const summaryCls = 'mb-5 rounded-xl bg-[#202c33] p-3.5';
const rowCls = 'flex justify-between py-1.5 text-sm leading-normal';
const rowLabelCls = 'text-[#8696a0]';
const monoCls = 'text-[13px] [font-family:monospace]';

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

  // Customer-facing refund request — eligible ONLY when the transfer is paid
  // (a paid transfer is by definition not yet delivered — status is one value)
  // and no refund is in flight. The server action re-checks all of this (the
  // page render is never authoritative); this just gates the CTA.
  const refundStatus = t.refundStatus ?? 'none';
  const canRequestRefund = t.status === 'paid' && refundStatus === 'none';

  return (
    <main className="flex min-h-svh justify-center bg-[#0b141a] px-4 py-8 text-[#e9edef] [font-family:-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif]">
      <div className="w-full max-w-[420px] rounded-2xl bg-[#111b21] p-7">
        <div className="mb-1 text-xl font-extrabold leading-normal text-[#25d366]">SmartRemit</div>
        <h1 className="mb-5 text-lg font-semibold leading-normal">Transfer receipt</h1>

        <div className={summaryCls}>
          <div className={rowCls}>
            <span className={rowLabelCls}>Status</span>
            <span className="font-semibold">{statusLabel(t)}</span>
          </div>
          <div className={rowCls}><span className={rowLabelCls}>Transfer ID</span><span className={monoCls}>{t.id}</span></div>
          <div className={rowCls}><span className={rowLabelCls}>Created</span><span>{fmtWhen(t.createdAt)}</span></div>
          {t.paidAt && <div className={rowCls}><span className={rowLabelCls}>Paid</span><span>{fmtWhen(t.paidAt)}</span></div>}
          {t.deliveredAt && <div className={rowCls}><span className={rowLabelCls}>Delivered</span><span>{fmtWhen(t.deliveredAt)}</span></div>}
          {t.status === 'blocked' && (
            <p className="mt-1.5 mb-0 text-[12px] leading-normal text-[#8696a0]">
              This transfer could not be completed and you were not charged.
            </p>
          )}
          {t.refundStatus === 'completed' && (
            <p className="mt-1.5 mb-0 text-[12px] leading-normal text-[#8696a0]">
              Refunded to your original payment method{t.refundedAt ? ` on ${fmtWhen(t.refundedAt)}` : ''}.
            </p>
          )}
        </div>

        <div className={summaryCls}>
          <div className={rowCls}><span className={rowLabelCls}>To</span><span className="font-semibold">{t.recipientName}</span></div>
          <div className={rowCls}>
            <span className={rowLabelCls}>Account</span>
            <span className={monoCls}>
              {t.payoutMethod.toUpperCase()} · {t.payoutDestination || '—'}
            </span>
          </div>
          <div className={rowCls}>
            <span className={rowLabelCls}>They receive</span>
            <span className="font-semibold">{formatDestAmount(t.amountInr, t.destinationCurrency ?? 'INR')}</span>
          </div>
        </div>

        <div className={summaryCls}>
          <div className={rowCls}><span className={rowLabelCls}>You send</span><span>{money(t.amountSource ?? t.amountUsd, srcCurrency)}</span></div>
          <div className={rowCls}><span className={rowLabelCls}>Fee</span><span>{money(t.feeSource ?? t.feeUsd, srcCurrency)}</span></div>
          <div className={`${rowCls} font-semibold`}>
            <span className={rowLabelCls}>Total charged</span>
            <span>{money(t.totalChargeSource ?? t.totalChargeUsd, srcCurrency)}</span>
          </div>
          <div className={`${rowCls} opacity-75`}>
            <span className={rowLabelCls}>Exchange rate</span>
            <span>1 {srcCurrency} = {t.fxRate} {t.destinationCurrency ?? 'INR'}</span>
          </div>
        </div>

        {canRequestRefund && (
          <form action={requestRefundAction} className="mb-5">
            <input type="hidden" name="transferId" value={t.id} />
            <button
              type="submit"
              className="block w-full rounded-2xl bg-[#202c33] p-4 text-center text-[15px] font-semibold text-[#e9edef] no-underline"
            >
              Request a refund
            </button>
            <p className="mt-2 mb-0 text-[12px] leading-normal text-[#8696a0]">
              Our team reviews every refund request — refunds arrive in 3–5 business days once approved.
            </p>
          </form>
        )}

        <p className="-mt-2 mb-5 text-[12px] leading-normal text-[#8696a0]">
          Rate locked when you confirmed. Questions? Reply to us on WhatsApp with this transfer ID.
        </p>
        <p className="mt-3">
          <Link href="/account/history" className="text-sm text-[#8696a0] underline">
            ← All transfers
          </Link>
        </p>
      </div>
    </main>
  );
}
