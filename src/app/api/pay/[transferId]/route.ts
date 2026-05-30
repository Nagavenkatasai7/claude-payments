import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { getCustomerStore } from '@/lib/customer-store';
import { getDraftStore } from '@/lib/draft-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { finalizeDraftPayment } from '@/lib/pay-finalize';
import { completePaymentStage1 } from '@/lib/payment';
import { sendText } from '@/lib/whatsapp';
import type { Transfer } from '@/lib/types';

export const maxDuration = 300; // unchanged — the mock still sleeps 120s inside after()

/**
 * Process payment for a resolved transfer, branching on complianceStatus:
 *  - blocked  → hard stop (no charge)
 *  - flagged  → charge via stage 1 (held message), set status in_review, no delivery
 *  - cleared  → normal: provider.initiateTransfer (stage1 + auto stage2 via after())
 */
async function processTransferPayment(
  store: ReturnType<typeof getStore>,
  transfer: Transfer,
): Promise<NextResponse> {
  if (transfer.complianceStatus === 'blocked') {
    return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
  }

  if (transfer.complianceStatus === 'flagged') {
    // Charge the card but do NOT deliver — hold for manual review.
    const { transfer: paid, senderMessages } = await completePaymentStage1(
      store, transfer.id, { held: true },
    );
    for (const msg of senderMessages) await sendText(paid.phone, msg);

    // Re-read after stage1 write (paidAt is now set) then update to in_review.
    const afterPay = await store.getTransfer(transfer.id);
    if (afterPay) {
      await store.saveTransfer({ ...afterPay, status: 'in_review' });
    }
    return NextResponse.json({ ok: true, status: 'in_review' });
  }

  // cleared (or any future status): normal auto-delivery path via the payment provider.
  const provider = getPaymentProvider(store);
  const { providerRef } = await provider.initiateTransfer(transfer);

  // Persist the settlement ref WITHOUT clobbering the 'paid' write initiateTransfer
  // just made: re-read, write the ref only when not already set, spread-merge.
  const settled = await store.getTransfer(transfer.id);
  if (settled && !settled.paymentProviderRef) {
    await store.saveTransfer({ ...settled, paymentProviderRef: providerRef });
  }
  return NextResponse.json({ ok: true, status: 'paid' });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;
  try {
    const store = getStore();
    const transfer = await store.getTransfer(transferId);

    if (transfer) {
      // ── Existing transfer branch ──────────────────────────────────────
      return await processTransferPayment(store, transfer);
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
    return await processTransferPayment(store, created);
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
