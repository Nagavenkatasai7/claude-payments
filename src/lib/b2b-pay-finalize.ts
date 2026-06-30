import { createTransfer } from './transfer-create';
import { isB2bSendVerified, sendGateActive } from './kyc-gate';
import { countryForCurrency } from './partner-currency';
import { newTransferId } from './id';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import type { DbOrTx } from '@/db/client';
import type { Store } from './store';
import type { CustomerStore } from './customer-store';
import type { PartnerStore } from './partner-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { CrossBorderBillQuote } from './b2b-quote';
import type { CurrencyCode } from './types';

// b2b-pay-finalize — pay-time mint for a CROSS-BORDER B2B bill (Plan 4). The
// generalization of the US-domestic ach_pull mint to a country-aware bank_pull.
//
// NON-CUSTODIAL: this function ONLY mints the ledger row + binds the idempotency
// key. It NEVER captures funds — the licensed partner debits the buyer AND pays
// the seller via the single signed dual-leg settlement instruction (the caller
// runs beginSettlement after this returns). There is no funds-provider call on
// this path at all.
//
// THE RECON'S BIGGEST GAP, CLOSED STRUCTURALLY: the seller's payout destination
// is resolved HERE from the SELLER PROFILE (getSellerDecrypted), never accepted
// from the caller / buyer input. The buyer's bank details only ever become the
// opaque funding token (raw digits never persisted) the route passes in.

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface CrossBorderFinalizeStores {
  store: Store;
  customerStore: CustomerStore;
  partnerStore: PartnerStore;
  monthlyVolumeStore: MonthlyVolumeStore;
  db: DbOrTx; // claim-first idempotency
}

export interface CrossBorderFinalizeInput {
  /** The cross-border invoice being paid (carries sellerId + the fixed obligation). */
  invoiceId: string;
  /** The LOCKED checkout quote (buyer-currency amounts) the buyer saw + pays. */
  quote: CrossBorderBillQuote;
  /** The buyer's currency, derived by the route from the invoice buyerPhone. */
  buyerCurrency: CurrencyCode;
  /** buyer→USD (route-fetched) — for the ledger USD-equivalent (screening + accrual). USD buyer ⇒ 1. */
  buyerToUsd: number;
  /** The OPAQUE buyer-bank funding token (raw bank digits NEVER persisted). */
  fundingToken: string;
}

export type CrossBorderFinalizeResult =
  | { ok: true; transferId: string }
  | {
      ok: false;
      error:
        | 'not_a_crossborder_bill'
        | 'not_payable'
        | 'seller_unavailable'
        | 'currency_mismatch'
        | 'buyer_unscreened'
        | 'blocked'
        | 'kyc_required';
      transferId?: string;
    };

export async function finalizeCrossBorderBillPayment(
  stores: CrossBorderFinalizeStores,
  input: CrossBorderFinalizeInput,
): Promise<CrossBorderFinalizeResult> {
  const { store, customerStore, partnerStore, monthlyVolumeStore, db } = stores;
  const { invoiceId, quote, buyerCurrency, buyerToUsd, fundingToken } = input;

  const invoice = await store.getB2bInvoice(invoiceId);
  if (
    !invoice ||
    !invoice.sellerId ||
    invoice.invoicedAmount === undefined ||
    !invoice.invoicedCurrency
  ) {
    return { ok: false, error: 'not_a_crossborder_bill' };
  }
  const partnerId = invoice.partnerId;
  const idem = createIdempotencyRepo(db);
  const idemKey = `b2binvoice:${invoiceId}`;

  // A non-unpaid bill is no longer payable — but a crash-replay of an
  // already-minted payment (invoice flipped 'paid' on delivery) must converge on
  // the SAME transfer, never error. The idempotency claim is the durable record.
  if (invoice.status !== 'unpaid') {
    const minted = await idem.find(partnerId, idemKey);
    if (minted) {
      const t = await store.getTransfer(minted);
      if (t) {
        return t.status === 'blocked'
          ? { ok: false, error: 'blocked', transferId: t.id }
          : { ok: true, transferId: t.id };
      }
    }
    return { ok: false, error: 'not_payable' };
  }

  // ── Defense: the locked quote must describe THIS obligation ───────────────
  // The buyer pays what they saw, but it must be the bill they were shown — a
  // stale-currency / wrong-amount lock can never mint against this invoice.
  if (
    quote.sellerCurrency !== invoice.invoicedCurrency ||
    quote.buyerCurrency !== buyerCurrency ||
    round2(quote.sellerAmount) !== round2(invoice.invoicedAmount)
  ) {
    return { ok: false, error: 'currency_mismatch' };
  }

  // ── SELLER PAYOUT — from the PROFILE ONLY, never from buyer input ─────────
  const sellerMasked = await store.getSellerById(invoice.sellerId);
  if (!sellerMasked || sellerMasked.status !== 'active' || sellerMasked.partnerId !== partnerId) {
    return { ok: false, error: 'seller_unavailable' };
  }
  const sellerDecrypted = await store.getSellerDecrypted(sellerMasked.phone, partnerId);
  const sellerPayout = (sellerDecrypted?.payoutDestination ?? '').trim();
  if (sellerPayout === '') return { ok: false, error: 'seller_unavailable' };

  // The obligation is FIXED in the seller currency; the seller nets it EXACTLY.
  const destinationCurrency = invoice.invoicedCurrency;
  const destinationCountry = countryForCurrency(destinationCurrency);
  const sellerAmount = round2(invoice.invoicedAmount);

  // ── Buyer (the payer) ─────────────────────────────────────────────────────
  const customer =
    (await customerStore.getCustomer(invoice.buyerPhone)) ??
    (await customerStore.upsertOnFirstInbound(invoice.buyerPhone)).customer;
  const partner =
    (await partnerStore.getPartner(partnerId)) ??
    (await partnerStore.ensureDefaultPartner());

  // KYB gate (defense-in-depth; the route gates first with friendly UX). WL1:
  // a 'delegated' partner runs KYB on their side ⇒ skip our gate. Sanctions on
  // BOTH parties still runs unconditionally inside createTransfer below.
  if (sendGateActive(partner) && !isB2bSendVerified(customer)) {
    return { ok: false, error: 'kyc_required' };
  }

  // SANCTIONS, structurally untoggleable on BOTH parties: the seller is always
  // screened (businessName, passed as recipientName below). screenTransfer SKIPS
  // an EMPTY senderName, so a nameless buyer (e.g. a brand-new buyer under a
  // 'delegated' partner where the KYB gate above is short-circuited) would slip
  // through UNSCREENED. CLAUDE.md: "KYC may be delegated; sanctions may not." So
  // FAIL CLOSED — never mint+settle a buyer we cannot screen by name.
  const buyerScreenName = (customer.fullName ?? '').trim();
  if (buyerScreenName === '') {
    return { ok: false, error: 'buyer_unscreened' };
  }

  // ── CLAIM-FIRST idempotent mint ───────────────────────────────────────────
  // Bind `b2binvoice:<invoiceId>` to a pre-generated id BEFORE minting. PK
  // (partner_id, key) ⇒ exactly one transfer can ever own this bill: a double
  // pay-submit or crash-replay converges on the winner, never a double-charge.
  const candidateId = newTransferId();
  const reservedId = await idem.claim(partnerId, idemKey, candidateId);
  if (reservedId !== candidateId) {
    const existing = await store.getTransfer(reservedId);
    if (existing) {
      return existing.status === 'blocked'
        ? { ok: false, error: 'blocked', transferId: existing.id }
        : { ok: true, transferId: existing.id };
    }
    // bound-but-unminted (a prior attempt crashed mid-mint) ⇒ re-mint THAT id.
  }

  // Ledger mapping follows the platform convention (quote()): amountSource is the
  // PRINCIPAL (so amountSource * fxRate ≈ amountDest reconciles), feeSource the
  // buyer-borne fee, totalChargeSource the full buyer debit (principal + fee). The
  // partner debits the FULL total, does FX on the principal, and pays the seller
  // `sellerAmount` EXACTLY. The USD-equivalent (screening + monthly accrual basis)
  // is the PRINCIPAL in USD, mirroring a normal send.
  const buyerPrincipal = round2(quote.buyerPrincipal);
  const feeBuyer = round2(quote.feeBuyer);
  const buyerTotal = round2(quote.buyerTotal); // = buyerPrincipal + feeBuyer (the debit)
  const amountUsd = round2(buyerPrincipal * buyerToUsd);
  const feeUsd = round2(feeBuyer * buyerToUsd);
  const totalChargeUsd = round2(amountUsd + feeUsd);

  const transfer = await createTransfer(store, partnerStore, monthlyVolumeStore, {
    id: reservedId, // claimed id — crash-replay re-mints the SAME row
    phone: invoice.buyerPhone, // the payer (buyer)
    recipientName: sellerMasked.businessName, // SCREENED (seller side)
    recipientPhone: sellerMasked.phone, // the delivered notification reaches the seller
    payoutMethod: 'bank',
    payoutDestination: sellerPayout, // FROM THE PROFILE — never buyer input
    fundingMethod: 'bank_pull',
    amountSource: buyerPrincipal, // (ignored under the quote override, but kept consistent)
    sourceCurrency: buyerCurrency,
    destinationCountry,
    destinationCurrency,
    partnerId,
    // Sanctions: createTransfer screens recipientName (seller) AND senderName
    // (the buyer's legal name) via the SAME seam — BOTH parties, block on a hit.
    senderName: buyerScreenName,
    senderKycStatus: customer.kycStatus,
    requiresKyc: sendGateActive(partner), // delegated ⇒ false; sanctions still run
    quote: {
      amountUsd,
      feeUsd,
      totalChargeUsd,
      fxRate: quote.fxRate,
      amountInr: sellerAmount, // destination amount = the seller's EXACT receipt
      amountSource: buyerPrincipal, // principal: amountSource * fxRate ≈ amountDest
      feeSource: feeBuyer,
      totalChargeSource: buyerTotal, // the buyer pays principal + fee
    },
    transferType: 'b2b',
    senderEntityType: 'business',
    recipientEntityType: 'business',
    senderBusinessName: buyerScreenName, // the payer business (masked at rest)
    recipientBusinessName: sellerMasked.businessName,
    achTokenRef: fundingToken, // OPAQUE buyer-bank funding token (no raw digits)
    invoiceId: invoice.id,
  });

  if (transfer.complianceStatus === 'blocked') {
    return { ok: false, error: 'blocked', transferId: transfer.id };
  }
  return { ok: true, transferId: transfer.id };
}
