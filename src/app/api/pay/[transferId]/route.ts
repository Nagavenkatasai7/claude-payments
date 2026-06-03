import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { getCustomerStore } from '@/lib/customer-store';
import { getDraftStore } from '@/lib/draft-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { finalizeDraftPayment, type BankDetails } from '@/lib/pay-finalize';
import { isSendVerified } from '@/lib/kyc-gate';
import { completePaymentStage1 } from '@/lib/payment';
import { sendText } from '@/lib/whatsapp';
import { validatePayoutFields, BANK_FIELDS_BY_COUNTRY } from '@/lib/payout-format';
import type { CountryCode, Transfer } from '@/lib/types';

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

const VALID_COUNTRY_CODES: ReadonlySet<string> = new Set<CountryCode>([
  'US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN',
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  // The route param is authoritative for which draft/transfer we're paying —
  // never trust an id in the body. The body only carries the bank-detail fields
  // the sender entered on the secure pay page (Item 2).
  const { transferId } = await params;
  try {
    const store = getStore();

    // ── Parse + validate the bank-detail body ONCE (shared by both branches) ──
    // Body shape: { country: CountryCode, fields: Record<string,string> }. We
    // server-validate via the SAME validator the form uses (single source of
    // truth); any 400 here happens BEFORE any charge. A bodyless POST (old
    // in-flight draft, or a re-opened link that already has a destination) skips
    // validation and falls back to the stored destination.
    let body: { country?: unknown; fields?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }
    const country =
      typeof body.country === 'string' && VALID_COUNTRY_CODES.has(body.country.toUpperCase())
        ? (body.country.toUpperCase() as CountryCode)
        : undefined;
    const rawFields =
      body.fields && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : undefined;
    const hasSubmittedFields =
      country !== undefined &&
      rawFields !== undefined &&
      BANK_FIELDS_BY_COUNTRY[country].some((f) => {
        const v = rawFields[f.key];
        return typeof v === 'string' && v.trim() !== '';
      });

    let bankDetails: BankDetails | undefined;
    if (hasSubmittedFields) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawFields!)) {
        if (typeof v === 'string') fields[k] = v;
      }
      const validation = validatePayoutFields(country!, fields);
      if (!validation.ok) {
        // 400 BEFORE any charge — nothing is mutated, the sender can retry.
        return NextResponse.json(
          { ok: false, error: 'Please check the bank details.', fieldErrors: validation.errors },
          { status: 400 },
        );
      }
      bankDetails = { payoutMethod: 'bank', payoutDestination: validation.payoutDestination };
    }

    const transfer = await store.getTransfer(transferId);

    if (transfer) {
      // ── Existing transfer branch ──────────────────────────────────────
      // Phase 3 verify-before-send gate — covers scheduled/cron transfers paid
      // on this page. Refuse BEFORE any charge if the owner isn't verified.
      const owner = await getCustomerStore(store).getCustomer(transfer.phone);
      if (!isSendVerified(owner)) {
        return NextResponse.json(
          { ok: false, error: 'Please verify your identity before sending.', kyc_required: true },
          { status: 403 },
        );
      }
      const hasDestination = (transfer.payoutDestination ?? '').trim() !== '';
      if (!hasDestination) {
        // A SCHEDULED/cron transfer is created with an empty destination (Item 2:
        // bank details are never collected in chat). They MUST be collected +
        // validated here on the secure page before charging — a no-account
        // transfer must never be delivered.
        if (!bankDetails) {
          return NextResponse.json(
            { ok: false, error: 'Bank details are required to complete this transfer.' },
            { status: 400 },
          );
        }
        const updated: Transfer = {
          ...transfer,
          payoutMethod: bankDetails.payoutMethod ?? 'bank',
          payoutDestination: bankDetails.payoutDestination ?? '',
        };
        await store.saveTransfer(updated);
        return await processTransferPayment(store, updated);
      }
      // Destination already set (re-opened link) → process exactly as before.
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
    const result = await finalizeDraftPayment(stores, transferId, bankDetails);
    if (!result.ok) {
      if (result.error === 'kyc_required') {
        return NextResponse.json(
          { ok: false, error: 'Please verify your identity before sending.', kyc_required: true },
          { status: 403 },
        );
      }
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
