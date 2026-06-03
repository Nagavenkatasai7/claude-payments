import { createTransfer } from './transfer-create';
import { isSendVerified } from './kyc-gate';
import { evaluateCap } from './tier-rules';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { Store } from './store';
import type { CustomerStore } from './customer-store';
import type { DraftStore } from './draft-store';
import type { PartnerStore } from './partner-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { DailyVolumeStore } from './daily-volume-store';
import type { PayoutMethod } from './types';

/**
 * Bank details collected on the secure pay page (Item 2). Both fields optional:
 * an absent/empty payoutDestination means "no body supplied" → fall back to the
 * draft's stored destination (covers old in-flight drafts during the TTL drain).
 */
export interface BankDetails {
  payoutMethod?: PayoutMethod;
  payoutDestination?: string;
}

export interface FinalizeStores {
  store: Store;
  customerStore: CustomerStore;
  draftStore: DraftStore;
  partnerStore: PartnerStore;
  monthlyVolumeStore: MonthlyVolumeStore;
  dailyVolumeStore: DailyVolumeStore;
}

export type FinalizeResult =
  | { ok: true; transferId: string }
  | { ok: false; error: 'expired_or_used' | 'cap' | 'blocked' | 'kyc_required'; transferId?: string };

/**
 * Pay-time finalization for a draft-keyed pay link: turns a Draft into a real
 * Transfer at the moment of payment (create-at-pay). Mirrors the createTransferTool
 * button-tap parity: peek → cap re-check → atomic consume → createTransfer (screens +
 * accrues count/today/monthly + saves recipient) → daily-cents → sticky EDD → sticky
 * funding. Returns the new transferId for the caller to run completePaymentStage1.
 */
export async function finalizeDraftPayment(
  stores: FinalizeStores,
  draftId: string,
  bankDetails?: BankDetails,
): Promise<FinalizeResult> {
  const { store, customerStore, draftStore, partnerStore, monthlyVolumeStore, dailyVolumeStore } = stores;

  // Peek first so a cap failure doesn't destroy the (single-use) draft.
  const peek = await draftStore.getDraft(draftId);
  if (!peek) return { ok: false, error: 'expired_or_used' };

  const customer =
    (await customerStore.getCustomer(peek.senderPhone)) ??
    (await customerStore.upsertOnFirstInbound(peek.senderPhone)).customer;

  // Phase 3 verify-before-send gate — refuse BEFORE consuming the draft so an
  // unverified sender keeps their (single-use) draft and can retry once verified.
  if (!isSendVerified(customer)) return { ok: false, error: 'kyc_required' };

  // Defense-in-depth cap re-check at pay time (the card-show check may be stale).
  const todayUsedCents = await dailyVolumeStore.getTodayCents(peek.senderPhone);
  const ev = evaluateCap(customer, new Date(), todayUsedCents, Math.round(peek.amountUsd * 100));
  if (!ev.withinCap) return { ok: false, error: 'cap' };

  // Atomic single-use consume (guards double-pay / double-click).
  const draft = await draftStore.consumeDraft(draftId);
  if (!draft) return { ok: false, error: 'expired_or_used' };

  // Item 2: the recipient's bank details are entered on the secure pay page and
  // arrive here in the POST body (bankDetails). Use them for the created
  // transfer, but FALL BACK to the draft's stored destination when the body is
  // empty/absent (covers old in-flight drafts still draining their 30-min TTL).
  const bodyDestination = (bankDetails?.payoutDestination ?? '').trim();
  const payoutDestination = bodyDestination !== ''
    ? bodyDestination
    : draft.recipient.payoutDestination ?? '';
  const payoutMethod =
    bodyDestination !== '' && bankDetails?.payoutMethod
      ? bankDetails.payoutMethod
      : draft.recipient.payoutMethod;

  const transfer = await createTransfer(store, partnerStore, monthlyVolumeStore, {
    phone: draft.senderPhone,
    recipientName: draft.recipient.name,
    recipientPhone: draft.recipient.recipientPhone,
    payoutMethod,
    payoutDestination,
    fundingMethod: draft.fundingMethod,
    amountSource: draft.amountSource,
    sourceCurrency: draft.sourceCurrency,
    destinationCountry: draft.destinationCountry,
    destinationCurrency: draft.destinationCurrency,
    partnerId: customer.partnerId ?? DEFAULT_PARTNER_ID,
    recipientLegalName: draft.recipientLegalName,
    relationship: draft.relationship,
    purpose: draft.purpose,
    sourceOfFunds: draft.sourceOfFunds,
    occupation: draft.occupation,
    senderName: customer.fullName,
    senderKycStatus: customer.kycStatus,
  });

  if (transfer.complianceStatus === 'blocked') {
    return { ok: false, error: 'blocked', transferId: transfer.id };
  }

  // Parity with createTransferTool: daily-cents, then sticky EDD (BEFORE funding so
  // recordFundingMethod's read-modify-write composes without clobbering it), then funding.
  await dailyVolumeStore.addCents(draft.senderPhone, Math.round(transfer.amountUsd * 100));
  if (
    draft.sourceOfFunds && draft.occupation &&
    (customer.sourceOfFunds !== draft.sourceOfFunds || customer.occupation !== draft.occupation)
  ) {
    const nowIso = new Date().toISOString();
    await customerStore.saveCustomer({
      ...customer, sourceOfFunds: draft.sourceOfFunds, occupation: draft.occupation,
      eddCapturedAt: nowIso, updatedAt: nowIso,
    });
  }
  await customerStore.recordFundingMethod(draft.senderPhone, draft.fundingMethod);

  return { ok: true, transferId: transfer.id };
}
