import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';

export const maxDuration = 300; // unchanged — the mock still sleeps 120s inside after()

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;
  try {
    const store = getStore();
    const transfer = await store.getTransfer(transferId);
    if (!transfer) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const provider = getPaymentProvider(store);
    // Stage 1 + (mock) self-advancing stage 2 — payment.ts stages are unchanged.
    const { providerRef } = await provider.initiateTransfer(transfer);

    // Persist the settlement ref WITHOUT clobbering the 'paid' write initiateTransfer
    // just made: re-read, write the ref only when not already set, spread-merge.
    const settled = await store.getTransfer(transferId);
    if (settled && !settled.paymentProviderRef) {
      await store.saveTransfer({ ...settled, paymentProviderRef: providerRef });
    }

    return NextResponse.json({ ok: true, status: 'paid' });
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
