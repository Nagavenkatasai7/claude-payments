import { quote } from './fx';
import { getFxRates } from './rate';
import { screenTransfer } from './compliance';
import { resolveCorridorRules } from './compliance-config';
import { newTransferId } from './id';
import { countryForCurrency } from './partner-currency';
import { evaluateEddForTransfer } from './tier-rules';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type {
  CurrencyCode, FundingMethod, PartnerId, PayoutMethod, Transfer,
  SenderRecipientRelationship, TransferPurpose, SourceOfFunds, Occupation,   // NEW (KYC)
} from './types';
import { DEFAULT_DESTINATION_COUNTRY, DEFAULT_DESTINATION_CURRENCY } from './defaults';

export interface CreateTransferInput {
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountSource: number;          // CHANGED (P4): was amountUsd
  sourceCurrency: CurrencyCode;  // NEW (P4)
  partnerId: PartnerId;          // NEW (P4): from the owning customer
  // ── KYC Travel-Rule (Tier 2) + EDD (Tier 4) — all optional (dormant) ──
  recipientLegalName?: string;
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  senderName?: string;          // sender legal name for sanctions screening (from customer.fullName)
}

export async function createTransfer(
  store: Store,
  partnerStore: PartnerStore,           // NEW (P5): to resolve corridor rules
  monthlyVolumeStore: MonthlyVolumeStore,   // NEW (KYC) — cumulative-month accrual + EDD trigger
  input: CreateTransferInput,
): Promise<Transfer> {
  const transferCount = await store.getTransferCount(input.phone);
  const rates = await getFxRates(input.sourceCurrency);
  const q = quote(input.amountSource, input.sourceCurrency, rates, input.fundingMethod, transferCount);
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
  const transfer: Transfer = {
    id: newTransferId(),
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
    destinationCountry: DEFAULT_DESTINATION_COUNTRY,
    destinationCurrency: DEFAULT_DESTINATION_CURRENCY,
    partnerId: input.partnerId,
    amountSource: q.amountSource,
    feeSource: q.feeSource,
    totalChargeSource: q.totalChargeSource,
    recipientLegalName: input.recipientLegalName,   // NEW (KYC)
    relationship: input.relationship,               // NEW (KYC)
    purpose: input.purpose,                          // NEW (KYC)
    eddRequired: eddCheck.eddRequired,               // NEW (KYC)
  };
  await store.saveTransfer(transfer);
  await store.incrementTransferCount(input.phone);
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
    console.warn('upsertRecipient failed (non-fatal):', err);
  }

  return transfer;
}
