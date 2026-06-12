import { quote } from './fx';
import { getFxRates } from './rate';
import { screenTransfer } from './compliance';
import { resolveCorridorRules } from './compliance-config';
import { newTransferId } from './id';
import { logWarn } from './log';
import { countryForCurrency } from './partner-currency';
import { evaluateEddForTransfer } from './tier-rules';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type {
  CountryCode, CurrencyCode, Draft, FundingMethod, PartnerId, PayoutMethod, Transfer,
  SenderRecipientRelationship, TransferPurpose, SourceOfFunds, Occupation,   // NEW (KYC)
  KycStatus,                                                                 // NEW (Phase 3 gate)
} from './types';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';

export interface CreateTransferInput {
  // Stage 2c: callers running CLAIM-FIRST idempotency (partner API, draft
  // finalize) pre-generate and reserve the id, so a crash-replay re-mints the
  // SAME row instead of a duplicate. Absent ⇒ a fresh id (chat-tool paths).
  id?: string;
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountSource: number;          // CHANGED (P4): was amountUsd
  sourceCurrency: CurrencyCode;  // NEW (P4)
  destinationCountry?: CountryCode;  // NEW (any-to-any) — absent ⇒ DEFAULT_DESTINATION_COUNTRY ('IN')
  destinationCurrency?: CurrencyCode; // NEW (any-to-any) — absent ⇒ DEFAULT_DESTINATION_CURRENCY ('INR')
  partnerId: PartnerId;          // NEW (P4): from the owning customer
  // ── KYC Travel-Rule (Tier 2) + EDD (Tier 4) — all optional (dormant) ──
  recipientLegalName?: string;
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  senderName?: string;          // sender legal name for sanctions screening (from customer.fullName)
  senderKycStatus: KycStatus;   // NEW (Phase 3) — the chokepoint backstop refuses unless 'verified'
  requiresKyc?: boolean;        // NEW (WL1) — absent ⇒ true (default/'ours'). 'delegated' partners pass false to skip OUR verify gate. Sanctions still run regardless.
  // U7 (audit): a COMPLETE quote override — the figures the customer actually
  // approved (the draft's stored quote, as shown on the approval card and the
  // pay page). When present, the re-quote (transferCount + live FX) is skipped
  // and these values are written to the ledger verbatim. Sanctions screening,
  // EDD, and the monthly accrual all read their USD-equivalent from it.
  // Absent ⇒ behavior unchanged (quote from current state).
  quote?: {
    amountUsd: number;
    feeUsd: number;
    totalChargeUsd: number;
    fxRate: number;
    amountInr: number;
    amountSource: number;
    feeSource: number;
    totalChargeSource: number;
  };
  // Best-rate routing (internal — never customer/partner-API visible): the
  // partner whose RAIL settles this transfer because its rate won the corridor
  // at quote time. Honored ONLY together with `quote` (the figures that rate
  // produced) — see the guard in createTransfer. Absent ⇒ settle via partnerId.
  settlementPartnerId?: PartnerId;
}

/**
 * Build the COMPLETE quote override (CreateTransferInput['quote']) from a
 * draft's stored quote — the exact figures the approval card and the pay page
 * showed (U7 audit). USD drafts: source-side fields equal the USD fields by
 * definition. Non-USD drafts need their stored source-side figures; legacy
 * in-flight drafts that predate feeSource/totalChargeSource return undefined,
 * so the mint falls back to a live re-quote rather than mixing the draft's
 * USD figures with a live source-side recomputation. Shared by BOTH draft
 * mint paths (pay-page finalize + approve-button tap) so they price the same.
 */
export function quoteOverrideFromDraft(
  draft: Pick<Draft, 'amountUsd' | 'amountSource' | 'sourceCurrency' | 'quote'>,
): CreateTransferInput['quote'] {
  const dq = draft.quote;
  const totalChargeUsd =
    dq.totalChargeUsd ?? Math.round((draft.amountUsd + dq.feeUsd) * 100) / 100;
  if (draft.sourceCurrency === 'USD') {
    return {
      amountUsd: draft.amountUsd,
      feeUsd: dq.feeUsd,
      totalChargeUsd,
      fxRate: dq.fxRate,
      amountInr: dq.amountInr,
      amountSource: draft.amountUsd,
      feeSource: dq.feeUsd,
      totalChargeSource: totalChargeUsd,
    };
  }
  if (dq.feeSource !== undefined && dq.totalChargeSource !== undefined) {
    return {
      amountUsd: draft.amountUsd,
      feeUsd: dq.feeUsd,
      totalChargeUsd,
      fxRate: dq.fxRate,
      amountInr: dq.amountInr,
      amountSource: draft.amountSource,
      feeSource: dq.feeSource,
      totalChargeSource: dq.totalChargeSource,
    };
  }
  return undefined;
}

export async function createTransfer(
  store: Store,
  partnerStore: PartnerStore,           // NEW (P5): to resolve corridor rules
  monthlyVolumeStore: MonthlyVolumeStore,   // NEW (KYC) — cumulative-month accrual + EDD trigger
  input: CreateTransferInput,
): Promise<Transfer> {
  // Phase 3 backstop: the chokepoint refuses to mint a transfer for an unverified
  // sender. Callers gate earlier with friendly UX (a kyc_url hand-off / a cron
  // skip); this is the last line of defense so no future caller can bypass it.
  //
  // WL1: a 'delegated' partner (the licensed entity runs KYC on their side) passes
  // requiresKyc:false to lift OUR verify gate. Absent ⇒ true ⇒ unchanged default
  // behavior. ⚠️ This does NOT touch sanctions — screenTransfer below runs in
  // BOTH modes and screens the recipient (and sender, when a name is present).
  const requiresKyc = input.requiresKyc ?? true;
  if (requiresKyc && input.senderKycStatus !== 'verified') {
    throw new Error('kyc_required');
  }
  // Resolve destination — default to IN/INR for full back-compat (all existing tests unchanged).
  const destinationCountry = input.destinationCountry ?? DEFAULT_DESTINATION_COUNTRY;
  const destinationCurrency = input.destinationCurrency ?? DEFAULT_DESTINATION_CURRENCY;
  // U7 (audit): when the caller supplies the quote the customer approved (the
  // draft's stored quote), honor it verbatim — NO re-quote. Otherwise quote from
  // current state exactly as before. Everything downstream reads from `q`:
  // sanctions + EDD use q.amountUsd, the Transfer row takes all eight figures,
  // and the monthly accrual uses q.amountUsd (via transfer.amountUsd).
  let q: NonNullable<CreateTransferInput['quote']>;
  if (input.quote) {
    q = input.quote;
  } else {
    const transferCount = await store.getTransferCount(input.phone);
    const rates = await getFxRates(input.sourceCurrency);
    // Fetch dest rates for the cross-rate. For INR this returns {toInr:1,toUsd:0.0118}
    // and quote() takes the INR branch (rates.toInr) — identical to the pre-any-to-any behavior.
    const destRates = await getFxRates(destinationCurrency);
    q = quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, transferCount, destinationCurrency, destRates.toUsd);
  }
  const transfersToday = await store.getTodayTransferCount(input.phone);

  const sourceCountry = countryForCurrency(input.sourceCurrency);   // P4 symbol
  const partner = await partnerStore.getPartner(input.partnerId);   // NEW (P5)
  const rules = resolveCorridorRules(partner, sourceCountry);        // NEW (P5)
  const monthUsedCents = await monthlyVolumeStore.getMonthCents(input.phone);   // NEW (KYC)
  const compliance = await screenTransfer({                         // P5: corridor-aware
    amountUsd: q.amountUsd,            // USD-equivalent — UNCHANGED
    recipientName: input.recipientName,
    transfersToday,
    sourceCountry,                     // NEW (P5)
    rules,                             // NEW (P5)
    senderName: input.senderName,      // NEW (KYC) — screened via the same seam (undefined ⇒ no-op)
  });

  // EDD merge: a watchlist BLOCK always wins; EDD only ever ADDS a flag.
  const eddFieldsPresent = Boolean(input.sourceOfFunds && input.occupation);
  const eddCheck = evaluateEddForTransfer({
    monthUsedCents,
    requestedCents: Math.round(q.amountUsd * 100),
    eddFieldsPresent,
  });
  let complianceStatus = compliance.status;
  let complianceReasons = compliance.reasons;
  if (complianceStatus !== 'blocked' && eddCheck.flagReason) {
    complianceStatus = 'flagged';
    complianceReasons = [...complianceReasons, eddCheck.flagReason];
  }
  // Best-rate routing: a route is only ever honored together with the quote it
  // priced. If the quote override is absent we re-quoted at the CURRENT mid
  // above — settling that through the winning partner's rail would pay out at
  // a rate that partner never offered, so the route is dropped with the stale
  // rate (platform settle via the customer's own partnerId).
  const settlementPartnerId = input.quote ? input.settlementPartnerId : undefined;
  const transfer: Transfer = {
    id: input.id ?? newTransferId(),
    phone: input.phone,
    amountUsd: q.amountUsd,
    feeUsd: q.feeUsd,
    totalChargeUsd: q.totalChargeUsd,
    fxRate: q.fxRate,
    amountInr: q.amountInr,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    payoutMethod: input.payoutMethod,
    payoutDestination: input.payoutDestination,
    fundingMethod: input.fundingMethod,
    complianceStatus,
    complianceReasons,
    status: complianceStatus === 'blocked' ? 'blocked' : 'awaiting_payment',
    createdAt: new Date().toISOString(),
    sourceCountry,
    sourceCurrency: input.sourceCurrency,
    destinationCountry,
    destinationCurrency,
    partnerId: input.partnerId,
    settlementPartnerId,                             // best-rate routing (internal)
    amountSource: q.amountSource,
    feeSource: q.feeSource,
    totalChargeSource: q.totalChargeSource,
    recipientLegalName: input.recipientLegalName,   // NEW (KYC)
    relationship: input.relationship,               // NEW (KYC)
    purpose: input.purpose,                          // NEW (KYC)
    eddRequired: eddCheck.eddRequired,               // NEW (KYC)
  };
  await store.saveTransfer(transfer);
  // (transfer count is now DERIVED from the ledger — no counter to bump)
  await store.incrementTodayTransferCount(input.phone);
  await monthlyVolumeStore.addCents(input.phone, Math.round(transfer.amountUsd * 100));   // NEW (KYC)

  try {
    await store.upsertRecipient(input.phone, {
      name: input.recipientName,
      recipientPhone: input.recipientPhone,
      payoutMethod: input.payoutMethod,
      payoutDestination: input.payoutDestination,
      lastUsedAt: new Date().toISOString(),
    });
  } catch (err) {
    logWarn('transfer.upsert_recipient', err, { transferId: transfer.id });
  }

  return transfer;
}

export interface BlockedAttemptInput {
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountUsd: number;
  amountSource: number;
  sourceCurrency: CurrencyCode;
  feeUsd: number;
  feeSource: number;
  fxRate: number;
  amountInr: number;                  // destination-currency amount
  totalChargeUsd: number;
  totalChargeSource: number;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  partnerId: PartnerId;
  reasons: string[];
}

/**
 * Persist a watchlist-blocked attempt as an auditable, never-charged transfer
 * row (status='blocked'), so blocked attempts are visible in the ledger and
 * compliance views instead of vanishing silently.
 *
 * Unlike createTransfer's blocked branch, this writes ONLY the row: it does NOT
 * increment the all-time / today velocity counters, does NOT accrue monthly
 * volume, and does NOT upsert the (watchlisted) recipient. A blocked attempt
 * must never advance the customer's caps, EDD volume, or saved-recipient list.
 */
export async function recordBlockedAttempt(
  store: Store,
  input: BlockedAttemptInput,
): Promise<Transfer> {
  const transfer: Transfer = {
    id: newTransferId(),
    phone: input.phone,
    amountUsd: input.amountUsd,
    feeUsd: input.feeUsd,
    totalChargeUsd: input.totalChargeUsd,
    fxRate: input.fxRate,
    amountInr: input.amountInr,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    payoutMethod: input.payoutMethod,
    payoutDestination: input.payoutDestination,
    fundingMethod: input.fundingMethod,
    complianceStatus: 'blocked',
    complianceReasons: input.reasons,
    status: 'blocked',
    createdAt: new Date().toISOString(),
    sourceCountry: countryForCurrency(input.sourceCurrency),
    sourceCurrency: input.sourceCurrency,
    destinationCountry: input.destinationCountry,
    destinationCurrency: input.destinationCurrency,
    partnerId: input.partnerId,
    amountSource: input.amountSource,
    feeSource: input.feeSource,
    totalChargeSource: input.totalChargeSource,
  };
  await store.saveTransfer(transfer);
  return transfer;
}
