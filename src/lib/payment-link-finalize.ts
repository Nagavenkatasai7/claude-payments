import { assertQuoteOverrideFresh, createTransfer } from './transfer-create';
import { RateUnavailableError } from './rate';
import { QuoteError } from './fx';
import { isFlagOn, SendsPausedError } from './flags';
import { inDemo } from './demo-mode';
import { isSendVerified, sendGateActive } from './kyc-gate';
import { resolveEffectiveSendLimits, SendBusyError, SendCapError } from './send-limits';
import { evaluateCap } from './tier-rules';
import { resolveCorridorRules } from './compliance-config';
import { sanctionsAuditEvent } from './sanctions/evidence';
import { newTransferId } from './id';
import { isLinkTokenShape, linkPayability, linkQuote, type LinkFundingMethod } from './payment-links';
import { screenPayee } from './payees';
import type { LockedLinkRate } from './payment-link-quote';
import { createIdempotencyRepo, createAuditRepo } from '@/db/repos/aux-repos';
import { createPaymentLinkRepo, type PaymentLink } from '@/db/repos/payment-link-repo';
import { createPayeeRepo, type Payee } from '@/db/repos/payee-repo';
import type { Db } from '@/db/client';
import type { Store } from './store';
import type { CustomerStore } from './customer-store';
import type { PartnerStore } from './partner-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { DailyVolumeStore } from './daily-volume-store';
import type { Transfer } from './types';

// payment-link-finalize — Batch B2. The customer's payment of a link becomes ONE
// transfer, minted claim-first:
//
//   gates (nothing written): the link exists, paylinks.enabled is on for its
//   partner (fails closed), the customer phone is in demo mode, the payee is
//   APPROVED and the link's own tenant's, the link is open (or claimed with no
//   paid transfer yet: a retry), sends.paused is off, the quote is fresh;
//   → payee sanctions screen (both names; a sanctions.screen evidence row)
//   → ensureCustomer (NO WhatsApp opt-in) → KYC gate → cap pre-check
//   → CLAIM, one transaction: the `paylink:<linkId>` idempotency key is bound to
//     a pre-generated transfer id AND the link moves open → used. A second tab, a
//     crash replay or a retry gets the SAME id; a cancel or the expiry that won
//     first rolls the claim back (nothing bound).
//   → createTransfer with that id: the payout is the APPROVED payee's sealed
//     account, never customer input; recipient_entity_type business; purpose and
//     client_reference copied from the link; the payee never enters the
//     customer's saved recipients; the flat fee, no rewards.
//
// A refusal inside the mint (cap race, lock timeout, sends.paused race, a stale
// rate) leaves the key bound and the transfer unminted: the same customer's retry
// mints THAT id (linkPayability 'resume'), exactly like the draft pay link.

export interface LinkFinalizeStores {
  store: Store;
  customerStore: CustomerStore;
  partnerStore: PartnerStore;
  monthlyVolumeStore: MonthlyVolumeStore;
  dailyVolumeStore: DailyVolumeStore;
  db: Db;
}

export interface PayableLink {
  link: PaymentLink;
  payee: Payee;
  /** 'open' ⇒ the first payment; 'resume' ⇒ claimed before, no paid transfer yet. */
  payability: 'open' | 'resume';
  /** The transfer the claim minted, when it exists (still awaiting payment). */
  transfer: Transfer | null;
}

/** The idempotency key that binds a link to its one transfer (reserved in the Partner API). */
export const paylinkClaimKey = (linkId: string) => `paylink:${linkId}`;

/**
 * Resolve a link token to something payable NOW, or null. Every caller (the page,
 * the code request, the payment) treats null the same way: the one "no longer
 * active" answer. Reads only.
 */
export async function resolvePayableLink(
  db: Db,
  store: Pick<Store, 'getTransfer'>,
  token: string,
  now: Date = new Date(),
): Promise<PayableLink | null> {
  if (!isLinkTokenShape(token)) return null;
  const link = await createPaymentLinkRepo(db).getByToken(token);
  if (!link) return null;
  // Fails closed: a read failure answers false (flags.ts), and false is off.
  if (!(await isFlagOn(db, 'paylinks.enabled', { partnerId: link.partnerId }))) return null;
  if (!inDemo(link.customerPhone)) return null;
  const payee = await createPayeeRepo(db).getById(link.payeeId);
  if (!payee || payee.partnerId !== link.partnerId || payee.status !== 'approved') return null;
  let transfer: Transfer | null = null;
  if (link.transferId) {
    const t = await store.getTransfer(link.transferId);
    if (t && t.partnerId === link.partnerId) transfer = t;
  }
  const payability = linkPayability(link, transfer?.status ?? null, now);
  if (payability === 'inactive') return null;
  return { link, payee, payability, transfer };
}

export type LinkFinalizeError =
  | 'inactive'
  | 'sends_paused'
  | 'fx_unavailable'
  | 'quote_error'
  | 'payee_unavailable'
  | 'kyc_required'
  | 'cap'
  | 'busy'
  | 'blocked';

export type LinkFinalizeResult =
  | { ok: true; transferId: string }
  | { ok: false; error: LinkFinalizeError; transferId?: string };

class ClaimLostError extends Error {
  constructor() {
    super('paylink_claim_lost');
    this.name = 'ClaimLostError';
  }
}

export async function finalizeLinkPayment(
  stores: LinkFinalizeStores,
  input: { token: string; fundingMethod: LinkFundingMethod; rate: LockedLinkRate | null; now?: Date },
): Promise<LinkFinalizeResult> {
  const { store, customerStore, partnerStore, monthlyVolumeStore, dailyVolumeStore, db } = stores;
  const now = input.now ?? new Date();

  const payable = await resolvePayableLink(db, store, input.token, now);
  if (!payable) return { ok: false, error: 'inactive' };
  const { link, payee } = payable;
  const partnerId = link.partnerId;

  const partner = await partnerStore.getPartner(partnerId);
  if (!partner) return { ok: false, error: 'inactive' };

  // ── Payee sanctions screen, at EVERY payment (both names) ─────────────────
  const bank = await createPayeeRepo(db).getBankDetails(payee.id);
  if (!bank || bank.partnerId !== partnerId || bank.payoutDestination.trim() === '') {
    return { ok: false, error: 'payee_unavailable' };
  }
  const screen = await screenPayee(
    { legalName: payee.legalName, accountHolder: bank.accountHolder },
    resolveCorridorRules(partner, 'US'),
  );
  if (screen.evidence) await createAuditRepo(db).record(sanctionsAuditEvent(partnerId, payee.id, screen.evidence));
  if (screen.verdict !== 'clear') {
    if (screen.verdict === 'review') await createPayeeRepo(db).setScreening(payee.id, 'review');
    return { ok: false, error: screen.verdict === 'match' ? 'blocked' : 'payee_unavailable' };
  }

  // A claim whose transfer already exists (the charge failed before): the pay
  // route resumes THAT transfer (after the payee screen above, which runs at
  // every payment attempt); nothing is re-priced or re-minted here.
  if (payable.transfer) return { ok: true, transferId: payable.transfer.id };

  // sends.paused BEFORE anything is written (createTransfer re-checks under the
  // claim; that refusal is the resumable bound-but-unminted shape).
  if (await store.isFlagOn('sends.paused', { partnerId: [partnerId], corridor: 'IN' })) {
    return { ok: false, error: 'sends_paused' };
  }

  // The figures the customer saw: the LOCKED rate, the link's exact rupees. No
  // lock (it lapsed) ⇒ fx_unavailable: the page reloads with a fresh rate.
  if (!input.rate) return { ok: false, error: 'fx_unavailable' };
  let quote: ReturnType<typeof linkQuote>;
  try {
    quote = linkQuote(link.amountInr, { toInr: input.rate.toInr }, input.fundingMethod);
    assertQuoteOverrideFresh({ fxFetchedAt: input.rate.fetchedAt }, now.getTime());
  } catch (err) {
    if (err instanceof RateUnavailableError) return { ok: false, error: 'fx_unavailable' };
    if (err instanceof QuoteError) return { ok: false, error: 'quote_error' };
    throw err;
  }

  // ── The customer: resolve-or-create WITHOUT WhatsApp consent ──────────────
  const customer = await customerStore.ensureCustomer(partnerId, link.customerPhone);
  const requiresKyc = sendGateActive(partner);
  if (requiresKyc && !isSendVerified(customer)) return { ok: false, error: 'kyc_required' };
  // The sender is screened by the legal name on file, else the name the partner
  // gave for this customer (createTransfer screens it).
  const senderName = (customer.fullName ?? '').trim() || link.customerName;

  // Cap pre-check on ledger totals (the authoritative check re-runs under the
  // sender lock). Owner answer 8: the $500/day first-3-days cap stays.
  const todayUsedCents = await dailyVolumeStore.getTodayCents(partnerId, link.customerPhone);
  const ev = evaluateCap(
    customer, now, todayUsedCents, Math.round(quote.amountUsd * 100),
    requiresKyc, resolveEffectiveSendLimits(partner, customer),
  );
  if (!ev.withinCap) return { ok: false, error: 'cap' };

  // ── CLAIM: key + open → used, one transaction ─────────────────────────────
  let transferId: string;
  try {
    transferId = await db.transaction(async (tx) => {
      const candidate = newTransferId();
      const reserved = await createIdempotencyRepo(tx).claim(partnerId, paylinkClaimKey(link.id), candidate);
      if (reserved !== candidate) return reserved; // claimed before (a second tab, a retry)
      if (!(await createPaymentLinkRepo(tx).claimOpen(partnerId, link.id, candidate, now))) throw new ClaimLostError();
      await createAuditRepo(tx).record({
        partnerId,
        actor: 'pay-link',
        actorType: 'system',
        action: 'paylink.claim',
        subjectId: link.id,
        meta: { transferId: candidate },
      });
      return candidate;
    });
  } catch (err) {
    if (err instanceof ClaimLostError) return { ok: false, error: 'inactive' };
    throw err;
  }

  let transfer: Transfer;
  try {
    transfer = await createTransfer(store, partnerStore, monthlyVolumeStore, {
      id: transferId, // the claimed id: a replay re-mints the SAME row
      phone: link.customerPhone,
      partnerId,
      recipientName: payee.legalName, // screened (recipient side)
      recipientPhone: '',
      recipientLegalName: bank.accountHolder,
      payoutMethod: 'bank',
      payoutDestination: bank.payoutDestination, // the APPROVED payee's account — never customer input
      fundingMethod: input.fundingMethod,
      amountSource: quote.amountUsd,
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
      purpose: link.purpose,
      senderName,
      senderKycStatus: customer.kycStatus,
      requiresKyc,
      quote: {
        amountUsd: quote.amountUsd,
        feeUsd: quote.feeUsd,
        totalChargeUsd: quote.totalChargeUsd,
        fxRate: quote.fxRate,
        amountInr: quote.amountInr, // EXACT rupees: the link amount
        amountSource: quote.amountUsd,
        feeSource: quote.feeUsd,
        totalChargeSource: quote.totalChargeUsd,
        fxFetchedAt: input.rate.fetchedAt,
        fxAsOf: input.rate.asOf,
        fxOrigin: 'platform',
        fxProvider: input.rate.provider,
      },
      transferType: 'b2c',
      senderEntityType: 'individual',
      recipientEntityType: 'business',
      recipientBusinessName: payee.legalName,
      saveRecipient: false, // the payee never enters the customer's saved recipients
      clientReference: link.reference, // B1: the link reference is the order reference
    });
  } catch (err) {
    if (err instanceof RateUnavailableError) return { ok: false, error: 'fx_unavailable' };
    if (err instanceof SendCapError) return { ok: false, error: 'cap' };
    if (err instanceof SendBusyError) return { ok: false, error: 'busy' };
    if (err instanceof SendsPausedError) return { ok: false, error: 'sends_paused' };
    if (err instanceof Error && err.message === 'kyc_required') return { ok: false, error: 'kyc_required' };
    throw err;
  }
  if (transfer.complianceStatus === 'blocked') return { ok: false, error: 'blocked', transferId: transfer.id };
  return { ok: true, transferId: transfer.id };
}
