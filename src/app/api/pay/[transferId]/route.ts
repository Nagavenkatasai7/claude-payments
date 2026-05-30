import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { getCustomerStore } from '@/lib/customer-store';
import { getDraftStore } from '@/lib/draft-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { finalizeDraftPayment } from '@/lib/pay-finalize';

export const maxDuration = 300; // unchanged — the mock still sleeps 120s inside after()

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;
  try {
    const store = getStore();
    const transfer = await store.getTransfer(transferId);

    if (transfer) {
      // ── Existing transfer branch (UNCHANGED) ──────────────────────────
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
    }

    // ── Draft branch: treat id as a draftId and finalize at pay time ──────
    const stores = {
      store,
      customerStore: getCustomerStore(store),
      draftStore: getDraftStore(),
      partnerStore: getPartnerStore(),
      monthlyVolumeStore: getMonthlyVolumeStore(),
      dailyVolumeStore: getDailyVolumeStore(),
    };
    const result = await finalizeDraftPayment(stores, transferId);
    if (!result.ok) {
      const msg =
        result.error === 'cap'
          ? 'That amount exceeds your current limit.'
          : result.error === 'blocked'
            ? "We can't process this transfer."
            : 'This payment link is no longer active.';
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }

    // Finalized → now a real transfer; run the same payment path as the transfer branch.
    const created = await store.getTransfer(result.transferId);
    if (!created) {
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
    const provider = getPaymentProvider(store);
    const { providerRef } = await provider.initiateTransfer(created);
    const settled = await store.getTransfer(result.transferId);
    if (settled && !settled.paymentProviderRef) {
      await store.saveTransfer({ ...settled, paymentProviderRef: providerRef });
    }
    return NextResponse.json({ ok: true, status: 'paid' });
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
