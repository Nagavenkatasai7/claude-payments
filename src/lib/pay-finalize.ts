import { createTransfer } from './transfer-create';
import { isSendVerified, sendGateActive } from './kyc-gate';
import { evaluateCap } from './tier-rules';
import { DEFAULT_PARTNER_ID } from './defaults';
import { newTransferId } from './id';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import type { DbOrTx } from '@/db/client';
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
  db: DbOrTx; // idempotency claims (Stage 2c)
}

export type FinalizeResult =
  | { ok: true; transferId: string }
  | { ok: false; error: 'expired_or_used' | 'cap' | 'blocked' | 'kyc_required'; transferId?: string };

/**
 * Pay-time finalization for a draft-keyed pay link: turns a Draft into a real
 * Transfer at the moment of payment (create-at-pay). Mirrors the createTransferTool
 * button-tap parity: peek → gates → cap re-check → CLAIM-FIRST mint → consume →
 * accruals. Returns the new transferId for the caller to run the payment path.
 *
 * Stage 2c crash-safety: the idempotency key `draft:<draftId>` is bound to a
 * pre-generated transfer id BEFORE minting, and the draft is consumed AFTER.
 * A crash anywhere in between leaves a replayable state — re-POSTing the same
 * pay link deterministically converges on the same transfer instead of losing
 * the customer's link (the old consume-then-create order destroyed it).
 */
export async function finalizeDraftPayment(
  stores: FinalizeStores,
  draftId: string,
  bankDetails?: BankDetails,
): Promise<FinalizeResult> {
  const { store, customerStore, draftStore, partnerStore, monthlyVolumeStore, dailyVolumeStore, db } = stores;

  // Peek (never consumes) so a gate/cap failure keeps the single-use draft alive.
  const draft = await draftStore.getDraft(draftId);
  if (!draft) {
    // Expired draft — but a crash-replay of an ALREADY-FINALIZED link lands
    // here too (the draft was consumed after the mint). The idempotency claim
    // is the durable record: if this draftId minted a transfer, return it.
    const minted = await createIdempotencyRepo(db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`)
      ?? null;
    if (minted) {
      const t = await store.getTransfer(minted);
      if (t) {
        return t.status === 'blocked'
          ? { ok: false, error: 'blocked', transferId: t.id }
          : { ok: true, transferId: t.id };
      }
    }
    return { ok: false, error: 'expired_or_used' };
  }

  const customer =
    (await customerStore.getCustomer(draft.senderPhone)) ??
    (await customerStore.upsertOnFirstInbound(draft.senderPhone)).customer;
  // WL1: resolve the owning partner — drives the gate toggle + requiresKyc.
  const partner =
    (await partnerStore.getPartner(customer.partnerId)) ??
    (await partnerStore.ensureDefaultPartner());

  // Phase 3 verify-before-send gate — refuse BEFORE claiming/consuming so an
  // unverified sender keeps their (single-use) draft and can retry once verified.
  // WL1: skipped for a 'delegated' partner; sanctions still run in createTransfer.
  if (sendGateActive(partner) && !isSendVerified(customer)) return { ok: false, error: 'kyc_required' };

  // Defense-in-depth cap re-check at pay time (the card-show check may be stale).
  const todayUsedCents = await dailyVolumeStore.getTodayCents(draft.senderPhone);
  const ev = evaluateCap(customer, new Date(), todayUsedCents, Math.round(draft.amountUsd * 100), sendGateActive(partner));
  if (!ev.withinCap) return { ok: false, error: 'cap' };

  // CLAIM-FIRST: bind `draft:<draftId>` to a pre-generated id before minting.
  // PK(partner_id, key) means exactly one id can ever own this draft — a double
  // submit or crash-replay converges on the winner. The claim is keyed under
  // DEFAULT_PARTNER_ID deliberately: a draftId is globally unique, and the
  // expired-draft replay above must find it without knowing the customer's partner.
  const idem = createIdempotencyRepo(db);
  const candidateId = newTransferId();
  const reservedId = await idem.claim(DEFAULT_PARTNER_ID, `draft:${draftId}`, candidateId);
  if (reservedId !== candidateId) {
    // A prior attempt owns this draft. If it minted, replay its outcome; a
    // bound-but-unminted id means it crashed mid-mint — fall through and mint
    // THAT id so the replay completes the original attempt.
    const existing = await store.getTransfer(reservedId);
    if (existing) {
      return existing.status === 'blocked'
        ? { ok: false, error: 'blocked', transferId: existing.id }
        : { ok: true, transferId: existing.id };
    }
  }

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
    id: reservedId, // the claimed id — crash-replay re-mints the SAME row
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
    requiresKyc: sendGateActive(partner), // WL1: delegated ⇒ false; sanctions still run
  });

  // Consume AFTER the mint: the transfer now exists, so losing the draft here
  // costs nothing (the claim replays it); losing the transfer there was fatal.
  // A null consume just means a concurrent request beat us to it — harmless.
  await draftStore.consumeDraft(draftId);

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
