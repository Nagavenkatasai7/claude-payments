import {
  encryptField,
  decryptField,
  defaultProvider,
  type EncryptionKeyProvider,
} from '@/lib/field-crypto';
import type { transfers } from '@/db/schema';
import type {
  ComplianceStatus,
  CountryCode,
  CurrencyCode,
  EntityType,
  FundingMethod,
  PayoutMethod,
  RefundStatus,
  SenderRecipientRelationship,
  Transfer,
  TransferPurpose,
  TransferStatus,
} from '@/lib/types';

// repos/mappers — row ↔ existing domain types. The DOMAIN TYPES DO NOT CHANGE:
// tools.ts, agent.ts, dashboards, and the partner API keep their shapes; only
// the persistence representation differs (numeric-as-string, timestamptz,
// encrypted columns).
//
// Encryption policy (Security pack): payout destinations (full bank accounts)
// and recipient legal names are envelope-encrypted at rest via the existing
// field-crypto format. `*_last4` siblings are computed here at write time so
// list queries NEVER decrypt. Empty strings stay empty (no crypto touch — a
// row with no account never touches the master key).

export type TransferRow = typeof transfers.$inferSelect;
export type TransferInsert = typeof transfers.$inferInsert;

export function last4(value: string): string {
  const digits = value.replace(/\D/g, '');
  const tail = (digits.length >= 4 ? digits : value).slice(-4);
  return value ? tail : '';
}

export function sealOptional(
  value: string | undefined,
  provider: EncryptionKeyProvider,
): string | undefined {
  if (value === undefined || value === '') return value;
  return encryptField(value, provider);
}

export function openOptional(
  blob: string | null | undefined,
  provider: EncryptionKeyProvider,
): string | undefined {
  // Decrypt failures THROW (tamper/key mismatch must be loud, never a silent
  // fallback that quietly drops a bank account).
  if (blob === null || blob === undefined || blob === '') return blob ?? undefined;
  return decryptField(blob, provider);
}

const num = (v: string): number => Number(v);
const iso = (d: Date): string => d.toISOString();
const isoOpt = (d: Date | null): string | undefined => (d ? d.toISOString() : undefined);

export function transferToRow(
  t: Transfer,
  provider: EncryptionKeyProvider = defaultProvider(),
): TransferInsert {
  return {
    id: t.id,
    partnerId: t.partnerId,
    settlementPartnerId: t.settlementPartnerId ?? null,
    phone: t.phone,
    status: t.status,
    complianceStatus: t.complianceStatus,
    complianceReasons: t.complianceReasons,
    amountUsd: t.amountUsd.toFixed(2),
    feeUsd: t.feeUsd.toFixed(2),
    totalChargeUsd: t.totalChargeUsd.toFixed(2),
    amountSource: t.amountSource.toFixed(2),
    feeSource: t.feeSource.toFixed(2),
    totalChargeSource: t.totalChargeSource.toFixed(2),
    fxRate: String(t.fxRate),
    amountDest: t.amountInr.toFixed(2),
    sourceCountry: t.sourceCountry,
    sourceCurrency: t.sourceCurrency,
    destinationCountry: t.destinationCountry,
    destinationCurrency: t.destinationCurrency,
    recipientName: t.recipientName,
    recipientPhone: t.recipientPhone ?? '',
    payoutMethod: t.payoutMethod,
    payoutDestinationEnc: t.payoutDestination ? encryptField(t.payoutDestination, provider) : '',
    payoutDestinationLast4: last4(t.payoutDestination ?? ''),
    fundingMethod: t.fundingMethod,
    paymentProviderRef: t.paymentProviderRef ?? null,
    fundingRef: t.fundingRef ?? null,
    refundRef: t.refundRef ?? null,
    refundStatus: t.refundStatus ?? 'none',
    refundedAt: t.refundedAt ? new Date(t.refundedAt) : null,
    recipientLegalNameEnc: sealOptional(t.recipientLegalName, provider) ?? null,
    relationship: t.relationship ?? null,
    purpose: t.purpose ?? null,
    eddRequired: t.eddRequired ?? null,
    // ── B2B — business names encrypted at rest + ****last4 sibling (like the
    // recipient legal name); discriminators default to the consumer shape. ──
    transferType: t.transferType ?? 'b2c',
    senderEntityType: t.senderEntityType ?? 'individual',
    recipientEntityType: t.recipientEntityType ?? 'individual',
    senderBusinessNameEnc: sealOptional(t.senderBusinessName, provider) ?? null,
    senderBusinessNameLast4: t.senderBusinessName ? last4(t.senderBusinessName) : null,
    recipientBusinessNameEnc: sealOptional(t.recipientBusinessName, provider) ?? null,
    recipientBusinessNameLast4: t.recipientBusinessName ? last4(t.recipientBusinessName) : null,
    achTokenRef: t.achTokenRef ?? null,
    invoiceId: t.invoiceId ?? null,
    kybReviewNotes: t.kybReviewNotes ?? null,
    assignedTo: t.assignedTo ?? null,
    adminNote: t.adminNote ?? null,
    createdAt: new Date(t.createdAt),
    paidAt: t.paidAt ? new Date(t.paidAt) : null,
    deliveredAt: t.deliveredAt ? new Date(t.deliveredAt) : null,
  };
}

export interface RowToTransferOpts {
  /**
   * Decrypt the payout destination (and legal name). Default FALSE — list and
   * dashboard reads stay ciphertext-free and render `payoutDestinationLast4`
   * via the masked domain value `****<last4>`. Pass true ONLY where the full
   * value is genuinely needed (settlement instruction build, owner receipt).
   */
  decrypt?: boolean;
  provider?: EncryptionKeyProvider;
}

export function rowToTransfer(row: TransferRow, opts: RowToTransferOpts = {}): Transfer {
  const provider = opts.provider ?? defaultProvider();
  const payoutDestination = opts.decrypt
    ? (openOptional(row.payoutDestinationEnc, provider) ?? '')
    : row.payoutDestinationLast4
      ? `****${row.payoutDestinationLast4}`
      : '';
  const t: Transfer = {
    id: row.id,
    phone: row.phone,
    amountUsd: num(row.amountUsd),
    feeUsd: num(row.feeUsd),
    totalChargeUsd: num(row.totalChargeUsd),
    fxRate: num(row.fxRate),
    amountInr: num(row.amountDest),
    recipientName: row.recipientName,
    recipientPhone: row.recipientPhone,
    payoutMethod: row.payoutMethod as PayoutMethod,
    payoutDestination,
    fundingMethod: row.fundingMethod as FundingMethod,
    complianceStatus: row.complianceStatus as ComplianceStatus,
    complianceReasons: (row.complianceReasons as string[]) ?? [],
    status: row.status as TransferStatus,
    createdAt: iso(row.createdAt),
    sourceCountry: row.sourceCountry as CountryCode,
    sourceCurrency: row.sourceCurrency as CurrencyCode,
    destinationCountry: row.destinationCountry as CountryCode,
    destinationCurrency: row.destinationCurrency as CurrencyCode,
    partnerId: row.partnerId,
    amountSource: num(row.amountSource),
    feeSource: num(row.feeSource),
    totalChargeSource: num(row.totalChargeSource),
  };
  const paidAt = isoOpt(row.paidAt);
  if (paidAt) t.paidAt = paidAt;
  const deliveredAt = isoOpt(row.deliveredAt);
  if (deliveredAt) t.deliveredAt = deliveredAt;
  if (row.paymentProviderRef) t.paymentProviderRef = row.paymentProviderRef;
  if (row.settlementPartnerId) t.settlementPartnerId = row.settlementPartnerId;
  if (row.fundingRef) t.fundingRef = row.fundingRef;
  if (row.refundRef) t.refundRef = row.refundRef;
  t.refundStatus = (row.refundStatus as RefundStatus) ?? 'none';
  const refundedAt = isoOpt(row.refundedAt);
  if (refundedAt) t.refundedAt = refundedAt;
  if (opts.decrypt) {
    const legal = openOptional(row.recipientLegalNameEnc, provider);
    if (legal) t.recipientLegalName = legal;
  }
  if (row.relationship) t.relationship = row.relationship as SenderRecipientRelationship;
  if (row.purpose) t.purpose = row.purpose as TransferPurpose;
  if (row.eddRequired !== null && row.eddRequired !== undefined) t.eddRequired = row.eddRequired;
  if (row.assignedTo) t.assignedTo = row.assignedTo;
  if (row.adminNote) t.adminNote = row.adminNote;
  // ── B2B — discriminators always present; business names masked ****last4 by
  // default, full only on an explicit decrypt read (receipt / admin detail). ──
  t.transferType = (row.transferType as 'b2c' | 'b2b') ?? 'b2c';
  t.senderEntityType = (row.senderEntityType as EntityType) ?? 'individual';
  t.recipientEntityType = (row.recipientEntityType as EntityType) ?? 'individual';
  const senderBiz = opts.decrypt
    ? openOptional(row.senderBusinessNameEnc, provider)
    : row.senderBusinessNameLast4
      ? `****${row.senderBusinessNameLast4}`
      : undefined;
  if (senderBiz) t.senderBusinessName = senderBiz;
  const recipientBiz = opts.decrypt
    ? openOptional(row.recipientBusinessNameEnc, provider)
    : row.recipientBusinessNameLast4
      ? `****${row.recipientBusinessNameLast4}`
      : undefined;
  if (recipientBiz) t.recipientBusinessName = recipientBiz;
  if (row.achTokenRef) t.achTokenRef = row.achTokenRef;
  if (row.invoiceId) t.invoiceId = row.invoiceId;
  if (row.kybReviewNotes) t.kybReviewNotes = row.kybReviewNotes;
  return t;
}
