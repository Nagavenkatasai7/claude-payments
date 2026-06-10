import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDraftStore } from '@/lib/draft-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { finalizeDraftPayment, type BankDetails } from '@/lib/pay-finalize';
import { isSendVerified, sendGateActive } from '@/lib/kyc-gate';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getDb } from '@/db/client';
import { pokeWorker } from '@/lib/outbox';
import { beginSettlement } from '@/lib/settlement';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { completePaymentStage1 } from '@/lib/payment';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendText, sendTransactionOtp, type WaCreds } from '@/lib/whatsapp';
import { validatePayoutFields, BANK_FIELDS_BY_COUNTRY } from '@/lib/payout-format';
import type { CountryCode, Transfer } from '@/lib/types';

// (Stage 2b: the mock's 120s sleep is an outbox row now — no long-running function.)

/**
 * Process payment for a resolved transfer, branching on complianceStatus:
 *  - blocked  → hard stop (no charge)
 *  - flagged  → charge via stage 1 (held message), set status in_review, no delivery
 *  - cleared  → beginSettlement: ONE transaction flips paid + enqueues the
 *               stage-1 message and the rail effect (Stage 2c — atomic).
 */
async function processTransferPayment(
  store: ReturnType<typeof getStore>,
  transfer: Transfer,
): Promise<NextResponse> {
  if (transfer.complianceStatus === 'blocked') {
    return NextResponse.json({ ok: false, error: "We can't process this transfer." }, { status: 400 });
  }

  // WL2/WL3: the owning partner's outbound WhatsApp creds + settlement rail
  // drive everything below. Default/unconfigured ⇒ env number + mock rail.
  const integrations = await getPartnerIntegrationsStore().getIntegrations(transfer.partnerId);
  const waCreds = waCredsFrom(integrations);

  if (transfer.complianceStatus === 'flagged') {
    // Charge the card but do NOT deliver — hold for manual review.
    const { transfer: paid, senderMessages } = await completePaymentStage1(
      store, transfer.id, { held: true },
    );
    for (const msg of senderMessages) await sendText(paid.phone, msg, waCreds);

    // Re-read after stage1 write (paidAt is now set) then update to in_review.
    const afterPay = await store.getTransfer(transfer.id);
    if (afterPay) {
      await store.saveTransfer({ ...afterPay, status: 'in_review' });
    }
    return NextResponse.json({ ok: true, status: 'in_review' });
  }

  // cleared: the atomic settlement transaction (status flip + stage-1 message +
  // rail effect commit together; every effect dedupe-keyed; worker delivers).
  const result = await beginSettlement(getDb(), transfer, integrations, waCreds);
  pokeWorker(); // fast-path drain
  if (result.kind === 'already') {
    // Double submit / replay — the first settlement won; report current truth.
    const current = await store.getTransfer(transfer.id);
    return NextResponse.json({ ok: true, status: current?.status ?? 'paid' });
  }
  return NextResponse.json({ ok: true, status: result.webhookDriven ? 'processing' : 'paid' });
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
    let body: { country?: unknown; fields?: unknown; action?: unknown; otp?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    // ── Phase 3 Part B: per-transaction OTP step-up ──────────────────────────
    // Resolve the sender phone from the id (draft PEEK — never consumes — else
    // an existing transfer) so the code is bound to this exact transaction.
    const otpDraft = await getDraftStore().getDraft(transferId);
    const otpPhone = otpDraft?.senderPhone ?? (await store.getTransfer(transferId))?.phone ?? null;

    // (1) "request_otp": issue + deliver a code in-session (free-form). No charge.
    if (typeof body.action === 'string' && body.action === 'request_otp') {
      if (!otpPhone) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
      const issued = await getTransactionOtpStore().issue(transferId, otpPhone);
      if (issued.ok) {
        // WL2: the code arrives from the number the customer is mid-payment with.
        let otpCreds: WaCreds | undefined;
        try {
          const otpPartnerId = otpDraft
            ? (await getCustomerStore(store).getCustomer(otpDraft.senderPhone))?.partnerId
            : (await store.getTransfer(transferId))?.partnerId;
          if (otpPartnerId) {
            otpCreds = waCredsFrom(await getPartnerIntegrationsStore().getIntegrations(otpPartnerId));
          }
        } catch { /* fall back to the shared env number */ }
        try { await sendTransactionOtp(otpPhone, issued.code, otpCreds); } catch { /* generic surface; never log the code */ }
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // (2) Require a valid code before ANY money movement (covers BOTH branches).
    if (!otpPhone) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
    const otpCode = String(body.otp ?? '').replace(/\D/g, '');
    const otpCheck = await getTransactionOtpStore().verify(transferId, otpPhone, otpCode);
    if (!otpCheck.ok) {
      return NextResponse.json(
        { ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' },
        { status: 403 },
      );
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
      // WL1: skipped for a 'delegated' partner (they run KYC on their side).
      const owningPartner =
        (await getPartnerStore().getPartner(transfer.partnerId)) ??
        (await getPartnerStore().ensureDefaultPartner());
      if (sendGateActive(owningPartner) && !isSendVerified(owner)) {
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
      db: getDb(),
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
