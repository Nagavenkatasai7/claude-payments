import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getDb } from '@/db/client';
import { getB2bQuoteStore } from '@/lib/b2b-quote-store';
import { getFxRates } from '@/lib/rate';
import { finalizeCrossBorderBillPayment } from '@/lib/b2b-pay-finalize';
import { beginSettlement } from '@/lib/settlement';
import { isB2bSendVerified, sendGateActive } from '@/lib/kyc-gate';
import { countryForPhone, currencyForPhone } from '@/lib/partner-currency';
import { validatePayoutFields, BANK_FIELDS_BY_COUNTRY } from '@/lib/payout-format';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendTransactionOtp, type WaCreds } from '@/lib/whatsapp';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { pokeWorker } from '@/lib/outbox';
import { logError } from '@/lib/log';
import type { CountryCode, CurrencyCode } from '@/lib/types';

// Cross-border B2B bill checkout (Plan 4) — the country-aware sibling of
// /api/pay/[transferId]. The pay LINK is keyed by the INVOICE; the transfer is
// MINTED here at submit time (claim-first idempotent). NON-CUSTODIAL end to end:
// no funds-capture / PSP call anywhere on this path — the licensed partner debits
// the buyer's local bank AND pays the seller via ONE signed dual-leg instruction.

export const maxDuration = 60;

/**
 * Validate the buyer's LOCAL bank fields for THEIR country (per-country schema),
 * then derive an OPAQUE funding token. NON-CUSTODIAL + PII-minimal (mirrors the
 * ach_pull recipe): SmartRemit keeps ONLY `bankpull_<random>` — the raw bank
 * digits are never persisted. The partner (the licensed rail) performs the debit.
 */
function validateAndTokenizeBuyerBank(
  country: CountryCode,
  rawFields: Record<string, unknown> | undefined,
): { ok: true; token: string } | { ok: false; fieldErrors: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (rawFields) {
    for (const [k, v] of Object.entries(rawFields)) if (typeof v === 'string') fields[k] = v;
  }
  const validation = validatePayoutFields(country, fields);
  if (!validation.ok) return { ok: false, fieldErrors: validation.errors };
  return { ok: true, token: `bankpull_${randomBytes(24).toString('hex')}` };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;

  // Per-IP ceiling over the whole route (request_otp + pay attempts). Fail-open.
  const limited = await enforceIpRateLimit(req, 'pay', 30);
  if (limited) return limited;

  try {
    const store = getStore();

    let body: { action?: unknown; otp?: unknown; country?: unknown; fields?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    const invoice = await store.getB2bInvoice(invoiceId);
    // A cross-border bill carries the obligation FIXED in the seller currency.
    const isCrossBorder =
      !!invoice &&
      !!invoice.sellerId &&
      invoice.invoicedAmount !== undefined &&
      invoice.invoicedAmount > 0 &&
      !!invoice.invoicedCurrency;
    if (!invoice || !isCrossBorder) {
      return NextResponse.json({ ok: false, error: 'This bill is no longer active.' }, { status: 404 });
    }

    // Buyer country/currency are derived from the invoice buyerPhone — never input.
    const buyerCountry = countryForPhone(invoice.buyerPhone);
    const buyerCurrency = currencyForPhone(invoice.buyerPhone);
    if (!buyerCountry || !buyerCurrency || !BANK_FIELDS_BY_COUNTRY[buyerCountry]) {
      return NextResponse.json(
        { ok: false, error: "We can't accept a payment from your country yet." },
        { status: 400 },
      );
    }
    const buyerPhone = invoice.buyerPhone;

    // ── OTP step-up (keyed on the invoice; the code is bound to this bill) ─────
    const otpStore = getTransactionOtpStore();
    if (typeof body.action === 'string' && body.action === 'request_otp') {
      const issued = await otpStore.issue(invoiceId, buyerPhone);
      if (issued.ok) {
        let otpCreds: WaCreds | undefined;
        try {
          otpCreds = waCredsFrom(await getPartnerIntegrationsStore().getIntegrations(invoice.partnerId));
        } catch {
          /* fall back to the shared env number */
        }
        try {
          await sendTransactionOtp(buyerPhone, issued.code, otpCreds);
        } catch {
          /* generic surface; never log the code */
        }
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // ── Seller (masked) — drives the seller currency for the locked-quote check ─
    const seller = await store.getSellerById(invoice.sellerId!);
    if (!seller || seller.status !== 'active' || seller.partnerId !== invoice.partnerId) {
      return NextResponse.json({ ok: false, error: 'This bill is no longer payable.' }, { status: 400 });
    }
    const sellerCurrency = seller.currency;
    const invoicedAmount = invoice.invoicedAmount!;

    // ── The LOCKED checkout quote the buyer was shown (the page is the SOLE
    // compute+lock site). What-you-see-is-what-you-pay: we NEVER silently re-quote
    // here — if the lock is gone (expired) or no longer describes this bill, refuse
    // with `quote_expired` so the form reloads + re-shows the fresh total BEFORE the
    // buyer authorizes a different figure.
    const lockedQuote = await getB2bQuoteStore().getLockedQuote(invoiceId);
    if (
      !lockedQuote ||
      lockedQuote.buyerCurrency !== buyerCurrency ||
      lockedQuote.sellerCurrency !== sellerCurrency ||
      Math.round(lockedQuote.sellerAmount * 100) !== Math.round(invoicedAmount * 100)
    ) {
      return NextResponse.json(
        { ok: false, reason: 'quote_expired', error: 'The rate updated — please review the new total.' },
        { status: 409 },
      );
    }

    // ── Buyer's LOCAL bank fields (their country's schema) → opaque token ─────
    const rawFields =
      body.fields && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : undefined;
    const tokenized = validateAndTokenizeBuyerBank(buyerCountry, rawFields);
    if (!tokenized.ok) {
      return NextResponse.json(
        { ok: false, error: 'Please check your bank details.', fieldErrors: tokenized.fieldErrors },
        { status: 400 },
      );
    }

    // ── KYB gate (friendly UX before the mint; createTransfer backstops) ──────
    const customerStore = getCustomerStore(store);
    const partnerStore = getPartnerStore();
    const owner = await customerStore.getCustomer(buyerPhone);
    const owningPartner =
      (await partnerStore.getPartner(invoice.partnerId)) ?? (await partnerStore.ensureDefaultPartner());
    if (sendGateActive(owningPartner) && !isB2bSendVerified(owner)) {
      return NextResponse.json(
        { ok: false, error: 'Please verify your business before paying.', kyc_required: true },
        { status: 403 },
      );
    }

    // ── OTP step-up — verified LAST (right before money moves) so a recoverable
    // failure above (bad bank fields, expired quote, seller deactivated) never
    // BURNS the single-use code. Nothing below this line is reachable without a
    // valid code, and the mint+settle is the only money movement.
    const otpCode = String(body.otp ?? '').replace(/\D/g, '');
    const otpCheck = await otpStore.verify(invoiceId, buyerPhone, otpCode);
    if (!otpCheck.ok) {
      return NextResponse.json(
        { ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' },
        { status: 403 },
      );
    }

    // buyer→USD for the ledger USD-equivalent (screening + accrual basis) — the
    // CHARGED figure is the locked buyer-currency quote; this is internal only.
    const buyerRates = await getFxRates(buyerCurrency);
    const buyerToUsd = buyerCurrency === 'USD' ? 1 : buyerRates.toUsd;

    // ── Claim-first mint (seller payout pulled from the PROFILE inside) ───────
    const minted = await finalizeCrossBorderBillPayment(
      { store, customerStore, partnerStore, monthlyVolumeStore: getMonthlyVolumeStore(), db: getDb() },
      { invoiceId, quote: lockedQuote, buyerCurrency: buyerCurrency as CurrencyCode, buyerToUsd, fundingToken: tokenized.token },
    );
    if (!minted.ok) {
      if (minted.error === 'kyc_required') {
        return NextResponse.json(
          { ok: false, error: 'Please verify your business before paying.', kyc_required: true },
          { status: 403 },
        );
      }
      if (minted.error === 'currency_mismatch') {
        // The locked quote no longer matches the obligation — reload for a fresh one.
        return NextResponse.json(
          { ok: false, reason: 'quote_expired', error: 'The rate updated — please review the new total.' },
          { status: 409 },
        );
      }
      const msg =
        minted.error === 'blocked' || minted.error === 'buyer_unscreened'
          ? "We can't process this payment."
          : minted.error === 'seller_unavailable'
            ? 'This bill is no longer payable.'
            : 'This payment could not be completed.';
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }

    const transfer = await store.getTransfer(minted.transferId);
    if (!transfer) {
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
    // Already-settled (replay POST) → report current truth, no double settle.
    if (transfer.status !== 'awaiting_payment') {
      return NextResponse.json({ ok: true, status: transfer.status });
    }

    // ── NON-CUSTODIAL settlement: ONE signed dual-leg instruction; NO capture ─
    const railPartnerId = transfer.settlementPartnerId ?? transfer.partnerId;
    const integrationsStore = getPartnerIntegrationsStore();
    const railIntegrations = await integrationsStore.getIntegrations(railPartnerId);
    const brandIntegrations =
      railPartnerId === transfer.partnerId
        ? railIntegrations
        : await integrationsStore.getIntegrations(transfer.partnerId);
    const waCreds = waCredsFrom(brandIntegrations);

    const result = await beginSettlement(getDb(), transfer, railIntegrations, waCreds);
    pokeWorker();
    if (result.kind === 'already') {
      const current = await store.getTransfer(transfer.id);
      return NextResponse.json({ ok: true, status: current?.status ?? 'paid' });
    }
    return NextResponse.json({ ok: true, status: 'processing' });
  } catch (err) {
    logError('pay.b2b.route', err, { invoiceId });
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
