// Program-Fix 15 PR B — the Reg E remittance disclosure (12 CFR 1005.31).
//
// PURE builders: the pay page (pre-payment, §1005.31(b)(1)) and the receipt
// (§1005.31(b)(2)) render what these return. Amounts are the ones the caller
// already shows (the quote / the ledger row) — nothing is recomputed here, so
// the disclosure can never disagree with the pay form. All wording lives in
// ./legal/disclosure-drafts.ts (DRAFT for counsel). A B2B transfer returns null:
// a business is not a consumer "sender" (§1005.30).

import type { ResolvedDisclosure } from './partner-config';
import type { DisclosureSnapshotInput } from './payment-evidence';
import type { Transfer } from './types';
import { DEMO_NO_PARTNER_NOTE } from './legal/drafts';
import {
  CFPB_CONTACT,
  DATE_AVAILABLE_DELIVERED_PREFIX,
  DISCLOSURE_DRAFT_VERSION,
  DISCLOSURE_LABELS as L,
  DISCLOSURE_LINKS,
  PARTNER_DETAILS_PENDING,
  PREVIOUS_DISCLOSURE_VERSIONS,
  RIGHTS_SUMMARY,
  THIRD_PARTY_FEE_STATEMENT,
  dateAvailableEstimate,
  dateAvailableOnOrAbout,
} from './legal/disclosure-drafts';

/** §1005.34: the sender may cancel within 30 minutes of payment. */
export const CANCEL_WINDOW_MS = 30 * 60_000;

export interface DisclosureLine {
  label: string;
  value: string;
  strong?: boolean;
}

export interface DisclosureProvider {
  kind: 'demo' | 'pending' | 'configured';
  name: string | null;
  note: string | null;
  licenseIds: string[];
  phone: string | null;
  website: string | null;
  stateRegulator: ResolvedDisclosure['stateRegulator'];
}

export interface PrepaymentDisclosure {
  version: string;
  lines: DisclosureLine[];
  thirdPartyFeeNote: string;
  provider: DisclosureProvider;
  rightsSummary: string;
  links: ReadonlyArray<{ href: string; label: string }>;
}

export interface ReceiptDisclosure extends PrepaymentDisclosure {
  /** ISO time the §1005.34 window closes, while it is still open on a paid transfer; else null. */
  cancelDeadline: string | null;
  cfpb: typeof CFPB_CONTACT;
}

/** The exchange rate, rounded to 2-4 decimals (one rule for the pay page and the receipt). */
export function formatFxRate(rate: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
    useGrouping: false,
  }).format(rate);
}

/** "1 USD = 83.2346 INR" — the receipt's existing convention. */
export function formatRateLine(rate: number, source: string, dest: string): string {
  return `1 ${source} = ${formatFxRate(rate)} ${dest}`;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function providerBlock(d: ResolvedDisclosure): DisclosureProvider {
  if (d.demo) {
    return { kind: 'demo', name: null, note: DEMO_NO_PARTNER_NOTE, licenseIds: [], phone: null, website: null, stateRegulator: null };
  }
  return {
    kind: d.configured ? 'configured' : 'pending',
    name: d.licensedEntity,
    note: d.configured ? null : PARTNER_DETAILS_PENDING,
    licenseIds: d.licenseIds,
    phone: d.phone,
    website: d.website,
    stateRegulator: d.stateRegulator,
  };
}

/** Add n business days (Mon-Fri, UTC; holidays are not modelled — the result is an estimate). */
export function addBusinessDays(fromMs: number, n: number): Date {
  const d = new Date(fromMs);
  let left = n;
  const isWeekend = () => d.getUTCDay() === 0 || d.getUTCDay() === 6;
  // A weekend payment starts counting from the next business day.
  while (isWeekend()) d.setUTCDate(d.getUTCDate() + 1);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend()) left -= 1;
  }
  return d;
}

export interface PrepaymentView {
  transferType?: 'b2c' | 'b2b';
  sourceAmount: number;
  sourceFee: number;
  sourceTotalCharge: number;
  sourceCurrency: string;
  destAmount: number;
  destCurrency: string;
  fxRate: number;
}

function coreLines(v: PrepaymentView, dateAvailable: string): DisclosureLine[] {
  return [
    { label: L.transferAmount, value: money(v.sourceAmount, v.sourceCurrency) },
    { label: L.transferFees, value: money(v.sourceFee, v.sourceCurrency) },
    { label: L.total, value: money(v.sourceTotalCharge, v.sourceCurrency), strong: true },
    { label: L.exchangeRate, value: formatRateLine(v.fxRate, v.sourceCurrency, v.destCurrency) },
    { label: L.totalToRecipient, value: money(v.destAmount, v.destCurrency), strong: true },
    { label: L.dateAvailable, value: dateAvailable },
  ];
}

export function buildPrepaymentDisclosure(view: PrepaymentView, d: ResolvedDisclosure): PrepaymentDisclosure | null {
  if (view.transferType === 'b2b') return null;
  return {
    version: DISCLOSURE_DRAFT_VERSION,
    lines: coreLines(view, dateAvailableEstimate(d.deliveryBusinessDays)),
    thirdPartyFeeNote: THIRD_PARTY_FEE_STATEMENT,
    provider: providerBlock(d),
    rightsSummary: RIGHTS_SUMMARY,
    links: DISCLOSURE_LINKS,
  };
}

export interface ReceiptTransfer {
  transferType?: 'b2c' | 'b2b';
  status: string;
  amountSource: number;
  feeSource: number;
  totalChargeSource: number;
  sourceCurrency: string;
  amountInr: number;
  destinationCurrency: string;
  fxRate: number;
  paidAt?: string;
  deliveredAt?: string;
  /** Fix pack 4 (C21): the days stored on the row at mint; absent -> the partner's current value. */
  deliveryBusinessDays?: number;
}

export function buildReceiptDisclosure(t: ReceiptTransfer, d: ResolvedDisclosure, nowMs: number): ReceiptDisclosure | null {
  if (t.transferType === 'b2b') return null;
  return receiptCore(
    t,
    deliveryDaysFor(t, d),
    {
      sourceAmount: t.amountSource,
      sourceFee: t.feeSource,
      sourceTotalCharge: t.totalChargeSource,
      sourceCurrency: t.sourceCurrency,
      destAmount: t.amountInr,
      destCurrency: t.destinationCurrency,
      fxRate: t.fxRate,
    },
    providerBlock(d),
    nowMs,
  );
}

/**
 * Fix pack 6 (P11): the ONE set of receipt rules (date available, the §1005.34 deadline, no
 * date line for a cancelled or blocked row, the static texts), shared by buildReceiptDisclosure
 * (live configuration) and receiptFromSnapshot (what was acknowledged). Pure.
 */
function receiptCore(
  t: ReceiptTransfer,
  days: number,
  figures: PrepaymentView,
  provider: DisclosureProvider,
  nowMs: number,
): ReceiptDisclosure {
  const paidMs = t.paidAt ? Date.parse(t.paidAt) : NaN;
  const deliveredMs = t.deliveredAt ? Date.parse(t.deliveredAt) : NaN;
  const dateAvailable =
    t.status === 'delivered' && Number.isFinite(deliveredMs)
      ? `${DATE_AVAILABLE_DELIVERED_PREFIX} ${DATE_FMT.format(new Date(deliveredMs))}`
      : Number.isFinite(paidMs)
        ? dateAvailableOnOrAbout(DATE_FMT.format(addBusinessDays(paidMs, days)))
        : dateAvailableEstimate(days);
  // The window is keyed on paid_at, which markPaidIfInReview can move LATER
  // (customer-favourable). Shown only while a paid transfer is inside it.
  const deadlineMs = paidMs + CANCEL_WINDOW_MS;
  const cancelDeadline =
    t.status === 'paid' && Number.isFinite(paidMs) && nowMs < deadlineMs ? new Date(deadlineMs).toISOString() : null;
  // A cancelled or blocked transfer is never delivered: no date-available
  // estimate under "this transfer was cancelled" (the rights and CFPB rows stay).
  const neverDelivered = t.status === 'cancelled' || t.status === 'blocked';
  const lines = coreLines(figures, dateAvailable).filter((l) => !(neverDelivered && l.label === L.dateAvailable));
  return {
    version: DISCLOSURE_DRAFT_VERSION,
    lines,
    thirdPartyFeeNote: THIRD_PARTY_FEE_STATEMENT,
    provider,
    rightsSummary: RIGHTS_SUMMARY,
    links: DISCLOSURE_LINKS,
    cancelDeadline,
    cfpb: CFPB_CONTACT,
  };
}

/**
 * The optional `disclosureVersion` on the pay POST: ONLY a version whose wording
 * exists — the current one, or one retained in PREVIOUS_DISCLOSURE_VERSIONS for
 * the Rolling Release overlap. Anything else records no acknowledgement, so the
 * audit log never claims a customer acknowledged wording that was never shown.
 */
export function isDisclosureAckVersion(v: unknown): v is string {
  return typeof v === 'string' && (v === DISCLOSURE_DRAFT_VERSION || PREVIOUS_DISCLOSURE_VERSIONS.includes(v));
}

/** The provider block's kind for a resolved partner (recorded in the ack meta). */
export function disclosureProviderKind(d: ResolvedDisclosure): DisclosureProvider['kind'] {
  return providerBlock(d).kind;
}

// ── Fix pack 4 (C16): the disclosure snapshot stored on the transfer ────────────
//
// What the customer acknowledged at the pay step, written once by
// commitPaymentEvidence (C8) into transfers.disclosure_snapshot and frozen once
// the row is paid or in review. Figures and provider details only: no recipient
// name, masked account, phone or static legal text. The type and its parser land
// with the repo that is typed by them (T2); the builder is T7's.

export interface DisclosureSnapshotV1 {
  v: 1;
  version: string;
  configHash: string | null;
  shownHash: string | null;
  figures: {
    amountSource: number;
    feeSource: number;
    totalChargeSource: number;
    sourceCurrency: string;
    amountDest: number;
    destinationCurrency: string;
    fxRate: number;
  };
  provider: {
    kind: 'demo' | 'pending' | 'configured';
    licensedEntity: string | null;
    licenceIds: string[];
    phone: string | null;
    website: string | null;
    regulator: string | null;
    approved: boolean;
  };
  deliveryBusinessDays: number;
  dateAvailable: string;
  acknowledgedAt: string;
  surface: 'transfer' | 'link';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const PROVIDER_KINDS: ReadonlySet<unknown> = new Set(['demo', 'pending', 'configured']);
const SNAPSHOT_SURFACES: ReadonlySet<unknown> = new Set(['transfer', 'link']);

/**
 * Parse a stored snapshot (jsonb, so untrusted shape). Returns a FRESH object
 * with only the V1 keys, or null for anything that is not a complete V1
 * snapshot. Pure; never throws.
 */
export function parseDisclosureSnapshot(raw: unknown): DisclosureSnapshotV1 | null {
  try {
    if (!isRecord(raw) || raw.v !== 1) return null;
    const { version, configHash, shownHash, figures: f, provider: p } = raw;
    if (typeof version !== 'string' || version === '') return null;
    if (!isStringOrNull(configHash) || !isStringOrNull(shownHash)) return null;
    if (!isRecord(f) || !isRecord(p)) return null;
    const { amountSource, feeSource, totalChargeSource, amountDest, fxRate, sourceCurrency, destinationCurrency } = f;
    if (![amountSource, feeSource, totalChargeSource, amountDest, fxRate].every(isFiniteNumber)) return null;
    if (typeof sourceCurrency !== 'string' || typeof destinationCurrency !== 'string') return null;
    const { kind, licensedEntity, licenceIds, phone, website, regulator, approved } = p;
    if (!PROVIDER_KINDS.has(kind)) return null;
    if (![licensedEntity, phone, website, regulator].every(isStringOrNull)) return null;
    if (!Array.isArray(licenceIds) || !licenceIds.every((x) => typeof x === 'string')) return null;
    if (typeof approved !== 'boolean') return null;
    const { deliveryBusinessDays, dateAvailable, acknowledgedAt, surface } = raw;
    if (!Number.isInteger(deliveryBusinessDays)) return null;
    const days = deliveryBusinessDays as number;
    if (days < 0 || days > 10) return null;
    if (typeof dateAvailable !== 'string' || typeof acknowledgedAt !== 'string') return null;
    if (!Number.isFinite(Date.parse(acknowledgedAt))) return null;
    if (!SNAPSHOT_SURFACES.has(surface)) return null;
    return {
      v: 1,
      version,
      configHash,
      shownHash,
      figures: {
        amountSource: amountSource as number,
        feeSource: feeSource as number,
        totalChargeSource: totalChargeSource as number,
        sourceCurrency,
        amountDest: amountDest as number,
        destinationCurrency,
        fxRate: fxRate as number,
      },
      provider: {
        kind: kind as DisclosureSnapshotV1['provider']['kind'],
        licensedEntity: licensedEntity as string | null,
        licenceIds: [...(licenceIds as string[])],
        phone: phone as string | null,
        website: website as string | null,
        regulator: regulator as string | null,
        approved,
      },
      deliveryBusinessDays: days,
      dateAvailable,
      acknowledgedAt,
      surface: surface as DisclosureSnapshotV1['surface'],
    };
  } catch {
    return null;
  }
}

/**
 * The business days a transfer's disclosure shows: the value stamped on the row
 * at mint (C2) wins, else the owner's current value. No truthiness: 0 (same
 * business day) is a stored value.
 */
export function deliveryDaysFor(t: Pick<Transfer, 'deliveryBusinessDays'>, d: ResolvedDisclosure): number {
  return t.deliveryBusinessDays ?? d.deliveryBusinessDays;
}

/**
 * The snapshot of what the customer acknowledged (C16), built from the LOCKED
 * row and the owner's resolved block. Figures and provider details only; the
 * provider kind follows providerBlock and the date available follows the
 * pay-page wording (dateAvailableEstimate of the stored days). `acknowledgedAt`
 * is the route's server time, falling back to `now` when not finite. Pure.
 */
export function buildDisclosureSnapshot(i: {
  transfer: Transfer;
  disclosure: ResolvedDisclosure;
  input: DisclosureSnapshotInput;
  now: number;
}): DisclosureSnapshotV1 {
  const { transfer: t, disclosure: d, input } = i;
  const p = providerBlock(d);
  const days = deliveryDaysFor(t, d);
  return {
    v: 1,
    version: input.version,
    configHash: d.hash,
    shownHash: input.shownHash,
    figures: {
      amountSource: t.amountSource,
      feeSource: t.feeSource,
      totalChargeSource: t.totalChargeSource,
      sourceCurrency: t.sourceCurrency,
      amountDest: t.amountInr,
      destinationCurrency: t.destinationCurrency ?? 'INR',
      fxRate: t.fxRate,
    },
    provider: {
      kind: p.kind,
      licensedEntity: p.name,
      licenceIds: [...p.licenseIds],
      phone: p.phone,
      website: p.website,
      regulator: p.stateRegulator?.name ?? null,
      approved: d.partnerApproved,
    },
    deliveryBusinessDays: days,
    dateAvailable: dateAvailableEstimate(days),
    acknowledgedAt: new Date(Number.isFinite(input.acknowledgedAt) ? input.acknowledgedAt : i.now).toISOString(),
    surface: input.surface,
  };
}

/**
 * Fix pack 6 (P11): the receipt's provider block from the snapshot's provider details, by the
 * providerBlock rule. The snapshot keeps the state regulator's NAME only (by design), so its
 * phone and website read null here (known limit; the live receipt keeps them). Pure.
 */
function snapshotProviderBlock(p: DisclosureSnapshotV1['provider']): DisclosureProvider {
  if (p.kind === 'demo') {
    return { kind: 'demo', name: null, note: DEMO_NO_PARTNER_NOTE, licenseIds: [], phone: null, website: null, stateRegulator: null };
  }
  return {
    kind: p.kind,
    name: p.licensedEntity,
    note: p.kind === 'configured' ? null : PARTNER_DETAILS_PENDING,
    licenseIds: [...p.licenceIds],
    phone: p.phone,
    website: p.website,
    stateRegulator: p.regulator ? { name: p.regulator, phone: null, website: null } : null,
  };
}

/**
 * Fix pack 6 (P11): the receipt of what was acknowledged; pure; the caller decides when a
 * snapshot applies (parsed and surface 'transfer'). Figures and provider come from the snapshot,
 * the date and the deadline from the transfer's paidAt / deliveredAt and the snapshot's stored
 * days, by exactly buildReceiptDisclosure's rules (receiptCore). `version` stays
 * DISCLOSURE_DRAFT_VERSION: the wording rendered is today's static text; the acknowledged version
 * lives in the snapshot and the ack audit row. A b2b transfer returns null.
 */
export function receiptFromSnapshot(s: DisclosureSnapshotV1, t: ReceiptTransfer, nowMs: number): ReceiptDisclosure | null {
  if (t.transferType === 'b2b') return null;
  const f = s.figures;
  return receiptCore(
    t,
    s.deliveryBusinessDays,
    {
      sourceAmount: f.amountSource,
      sourceFee: f.feeSource,
      sourceTotalCharge: f.totalChargeSource,
      sourceCurrency: f.sourceCurrency,
      destAmount: f.amountDest,
      destCurrency: f.destinationCurrency,
      fxRate: f.fxRate,
    },
    snapshotProviderBlock(s.provider),
    nowMs,
  );
}
