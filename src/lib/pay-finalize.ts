import { assertQuoteOverrideFresh, createTransfer, quoteOverrideFromDraft } from './transfer-create';
import { getDestinationRates, getFxRates, RateUnavailableError } from './rate';
import { isSendVerified, isB2bSendVerified, sendGateActive } from './kyc-gate';
import { resolveEffectiveSendLimits, SendBusyError, SendCapError } from './send-limits';
import { evaluateCap } from './tier-rules';
import { draftTenant } from './legacy-tenant';
import { DEFAULT_DESTINATION_CURRENCY, DEFAULT_PARTNER_ID } from './defaults';
import { newTransferId } from './id';
import { isMaskedDestination } from './payout-format';
import { isPartnerPulled } from './funding-method';
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
 * draft's stored destination, used only when it is a real account (fix 6: a
 * placeholder, or '' on anything but a B2B ach_pull draft, answers
 * bank_details_required; a B2B draft ignores the body).
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
  | {
      ok: false;
      // 'bank_details_required' (fix 6 / ctx-01): the resolved payout destination
      // is a masked placeholder, or '' on anything but a B2B ach_pull draft.
      // Nothing was claimed or consumed; the route answers 400. Never a 500.
      // 'busy' (Program fix 16): the per-sender mint lock timed out (another
      // send for this customer is in flight). Retryable — the draft and its
      // claim are untouched (a bound-but-unminted id replays); the route
      // answers 503 "Please try again."
      error: 'expired_or_used' | 'cap' | 'blocked' | 'kyc_required' | 'fx_unavailable' | 'bank_details_required' | 'busy';
      transferId?: string;
      // Task 9 (review): set only on 'fx_unavailable' when the draft's stored
      // quote aged past the ceiling — a retry can never succeed (the customer
      // needs a fresh quote), so the route answers the expired-quote message.
      quoteExpired?: true;
    };

/** Task 9: a RateUnavailableError → the fx_unavailable arm (same shape pre- and post-claim). */
function fxRefused(err: RateUnavailableError): FinalizeResult {
  return err.reason === 'stale_quote'
    ? { ok: false, error: 'fx_unavailable', quoteExpired: true }
    : { ok: false, error: 'fx_unavailable' };
}

/**
 * Pay-time finalization for a draft-keyed pay link: turns a Draft into a real
 * Transfer at the moment of payment (create-at-pay). Mirrors the createTransferTool
 * button-tap parity: peek → kyc → payout destination (fix 6) → FX (Task 9) → cap →
 * CLAIM-FIRST mint (the cap re-runs under the sender lock, fix 16) → consume. Returns the new transferId for the
 * caller to run the payment path.
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

  // The draft's tenant (fix 1). A pre-deploy in-flight draft (no partnerId)
  // resolves to the phone's pre-fix (oldest-row) tenant, else default.
  const partnerId = await draftTenant(draft, store.legacyTenantOf);
  const customer =
    (await customerStore.getCustomer(partnerId, draft.senderPhone)) ??
    (await customerStore.upsertOnFirstInbound(partnerId, draft.senderPhone)).customer;
  // WL1: resolve the owning partner — drives the gate toggle + requiresKyc.
  const partner =
    (await partnerStore.getPartner(partnerId)) ??
    (await partnerStore.ensureDefaultPartner());

  // Phase 3 verify-before-send gate — refuse BEFORE claiming/consuming so an
  // unverified sender keeps their (single-use) draft and can retry once verified.
  // B2B drafts use the B2B-aware KYB predicate (isB2bSendVerified === isSendVerified
  // for the MVP). WL1: skipped for a 'delegated' partner; sanctions still run.
  const payVerified =
    draft.transferType === 'b2b' ? isB2bSendVerified(customer) : isSendVerified(customer);
  if (sendGateActive(partner) && !payVerified) return { ok: false, error: 'kyc_required' };

  // ── fix 6 (ctx-01): resolve the payout destination BEFORE the claim ───────
  // Ruling 7 guard order, all ABOVE idem.claim: kyc → THIS → FX (Task 9) → cap
  // (Task 10) → idem.claim. A refusal leaves the single-use draft AND its
  // draft:<draftId> key untouched. Pure function of (draft, body).
  //
  // A CONSUMER draft carrying a partner-pulled method (ach_pull / bank_pull —
  // only a pre-fix model argument could create one) would never be charged:
  // it is dead, never minted (createTransfer refuses it too).
  if (isPartnerPulled(draft.fundingMethod) && draft.transferType !== 'b2b') {
    return { ok: false, error: 'expired_or_used' };
  }
  //   body → route.ts composed it from validated, country-bound fields; it also
  //          REPLACES a stored destination (the page's "Edit bank details") —
  //          on a CONSUMER draft only: a B2B payee is never payer input.
  //   none → the draft's stored destination, used ONLY when it is a real account.
  //          '' ("the pay page must collect it") is refused except on a B2B
  //          ach_pull draft, whose pay form collects only the payer's debit
  //          mandate (the licensed partner pays the payee on its own records).
  const bodyDestination =
    draft.transferType === 'b2b' ? '' : (bankDetails?.payoutDestination ?? '').trim();
  const payoutDestination =
    bodyDestination !== '' ? bodyDestination : (draft.recipient.payoutDestination ?? '').trim();
  const b2bAchPull = draft.transferType === 'b2b' && draft.fundingMethod === 'ach_pull';
  if (isMaskedDestination(payoutDestination) || (payoutDestination === '' && !b2bAchPull)) {
    return { ok: false, error: 'bank_details_required' };
  }
  const payoutMethod =
    bodyDestination !== '' && bankDetails?.payoutMethod
      ? bankDetails.payoutMethod
      : draft.recipient.payoutMethod;
  // Crash-replay (fix 10 review): the destination above is resolved from THIS
  // request, but once `draft:<draftId>` is bound to a minted transfer, the claim
  // below replays that row — so a retry whose body differs (another account)
  // still settles with the FIRST body's destination. The mint already happened;
  // it is never re-minted or edited from a replay.

  // [fix 6 inserts above this line]
  // ── FX gate (Task 9) — BEFORE idem.claim, so a provider outage or a stale
  // quote never burns the single-use draft key (ruling 7 pre-claim contract:
  // kyc → masked destination (fix 6) → FX (this) → cap (fix 10) → idem.claim).
  // A draft with a COMPLETE stored quote is honored verbatim — never re-quoted
  // — so the only check is the age of the rate behind it. A legacy draft with
  // no complete quote re-quotes inside createTransfer, so pre-flight both FX
  // legs here (this also warms the L1 cache the mint reads moments later).
  // A draft that ALREADY minted (the process died after the mint, before
  // consumeDraft) skips the gate: the claim below replays that transfer's
  // outcome, and a replay is never re-priced or refused for FX. A bound-but-
  // UNminted claim is still gated — nothing has been priced into the ledger.
  const quoteOverride = quoteOverrideFromDraft(draft);
  const idem = createIdempotencyRepo(db);
  const priorClaim = await idem.find(DEFAULT_PARTNER_ID, `draft:${draftId}`);
  const alreadyMinted = priorClaim !== null && (await store.getTransfer(priorClaim)) !== null;
  if (!alreadyMinted) {
    try {
      if (quoteOverride) {
        assertQuoteOverrideFresh(quoteOverride);
      } else {
        await getFxRates(draft.sourceCurrency);
        await getDestinationRates(draft.destinationCurrency ?? DEFAULT_DESTINATION_CURRENCY);
      }
    } catch (err) {
      if (err instanceof RateUnavailableError) return fxRefused(err);
      throw err;
    }
  }

  // Defense-in-depth cap re-check at pay time (the card-show check may be
  // stale), the LAST pre-claim gate (ruling 7), on LEDGER totals and the
  // sender's EFFECTIVE limits (fix 16b: customer → partner → platform). The authoritative check runs
  // again inside createTransfer's sender lock. SKIPPED when the draft already
  // minted: the minted row would count itself and refuse its own replay.
  if (!alreadyMinted) {
    const todayUsedCents = await dailyVolumeStore.getTodayCents(partnerId, draft.senderPhone);
    const ev = evaluateCap(
      customer, new Date(), todayUsedCents, Math.round(draft.amountUsd * 100),
      sendGateActive(partner), resolveEffectiveSendLimits(partner, customer),
    );
    if (!ev.withinCap) return { ok: false, error: 'cap' };
  }

  // CLAIM-FIRST: bind `draft:<draftId>` to a pre-generated id before minting.
  // PK(partner_id, key) means exactly one id can ever own this draft — a double
  // submit or crash-replay converges on the winner. The claim is keyed under
  // DEFAULT_PARTNER_ID deliberately: a draftId is globally unique, and the
  // expired-draft replay above must find it without knowing the customer's partner.
  // (`idem` is created above by the FX gate — Task 9.)
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

  // U7 (audit): mint with the DRAFT's stored quote — the exact figures the
  // approval card and the pay page showed. Re-quoting at pay time (current
  // transferCount + live FX) could flip "first transfer free" into a $1.99
  // charge if another transfer landed in between, or drift the FX rate between
  // card and payment. quoteOverrideFromDraft owns the USD / non-USD / legacy
  // rules (legacy non-USD drafts get NO override and fall back to a re-quote).
  // (quoteOverride is computed ABOVE the claim by the FX gate — Task 9.)

  // ── B2B: the pay page is the PRIMARY mint path (the Approve & Pay card opens
  // /pay/<draftId>), so it MUST thread the same B2B discriminators + business
  // names + linked invoice the draft carries. Without this a B2B bill paid via
  // the card would mint as a plain b2c transfer — the business names + invoice
  // link lost and, critically, the PAYER business unscreened. For sanctions the
  // sender name becomes the payer business legal name (createTransfer screens it).
  // achTokenRef is bound by the rail at pay/settlement time (U2), never here. ──
  const isB2bDraft = draft.transferType === 'b2b';

  // Task 9 (review): the FX gate above ran moments ago, but the stored quote's
  // rate — or a legacy re-quote's live rate — can still cross the 60-min
  // ceiling between the gate and this mint. createTransfer refuses BEFORE any
  // write, so map it exactly like the pre-claim gate: the claimed id stays
  // bound-but-UNMINTED and the draft is not consumed, so a retry of the same
  // link falls through the claim's replay branch and mints THAT id (the
  // existing crash-replay shape). Never the route's generic 400.
  let transfer: Awaited<ReturnType<typeof createTransfer>>;
  try {
    transfer = await createTransfer(store, partnerStore, monthlyVolumeStore, {
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
      partnerId,
      recipientLegalName: draft.recipientLegalName,
      relationship: draft.relationship,
      purpose: draft.purpose,
      sourceOfFunds: draft.sourceOfFunds,
      occupation: draft.occupation,
      // For B2B, screen the PAYER business name (else the individual sender name).
      senderName: (isB2bDraft ? draft.senderBusinessName : undefined) ?? customer.fullName,
      senderKycStatus: customer.kycStatus,
      requiresKyc: sendGateActive(partner), // WL1: delegated ⇒ false; sanctions still run
      quote: quoteOverride, // U7: honor the draft's quote (undefined ⇒ legacy re-quote)
      // Best-rate routing: the winning partner's rail settles this transfer —
      // but ONLY at the rate it offered (the draft's quote). The legacy fallback
      // above re-quotes at mid, so it must drop the route too (never a
      // partner-routed transfer at a platform rate).
      settlementPartnerId: quoteOverride ? draft.settlementPartnerId : undefined,
      // ── B2B discriminators + business names + linked invoice (undefined for b2c) ──
      transferType: draft.transferType,
      senderEntityType: draft.senderEntityType,
      recipientEntityType: draft.recipientEntityType,
      senderBusinessName: draft.senderBusinessName,
      recipientBusinessName: draft.recipientBusinessName,
      invoiceId: draft.invoiceId,
    });
  } catch (err) {
    if (err instanceof RateUnavailableError) return fxRefused(err);
    // Program fix 16: the in-lock cap refusal (a concurrent send took the
    // headroom between the pre-claim check and the lock) and the lock timeout.
    // Both leave the claimed id bound-but-UNMINTED and the draft unconsumed —
    // the same crash-replay shape as an FX refusal.
    if (err instanceof SendCapError) return { ok: false, error: 'cap' };
    if (err instanceof SendBusyError) return { ok: false, error: 'busy' };
    throw err;
  }

  // Consume AFTER the mint: the transfer now exists, so losing the draft here
  // costs nothing (the claim replays it); losing the transfer there was fatal.
  // A null consume just means a concurrent request beat us to it — harmless.
  await draftStore.consumeDraft(draftId);

  if (transfer.complianceStatus === 'blocked') {
    return { ok: false, error: 'blocked', transferId: transfer.id };
  }

  // Parity with createTransferTool: sticky EDD (BEFORE funding so
  // recordFundingMethod's read-modify-write composes without clobbering it),
  // then funding. (Today's spend is the ledger row itself — fix 16.)
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
  await customerStore.recordFundingMethod(partnerId, draft.senderPhone, draft.fundingMethod);

  return { ok: true, transferId: transfer.id };
}
