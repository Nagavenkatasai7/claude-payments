// Program-Fix 15 PR B — the Reg E remittance disclosure (12 CFR 1005.31).
//
// PURE builders: the pay page (pre-payment, §1005.31(b)(1)) and the receipt
// (§1005.31(b)(2)) render what these return. Amounts are the ones the caller
// already shows (the quote / the ledger row) — nothing is recomputed here, so
// the disclosure can never disagree with the pay form. All wording lives in
// ./legal/disclosure-drafts.ts (DRAFT for counsel). A B2B transfer returns null:
// a business is not a consumer "sender" (§1005.30).

import type { ResolvedDisclosure } from './partner-config';
import { DEMO_NO_PARTNER_NOTE } from './legal/drafts';
import {
  CFPB_CONTACT,
  DATE_AVAILABLE_DELIVERED_PREFIX,
  DISCLOSURE_DRAFT_VERSION,
  DISCLOSURE_LABELS as L,
  DISCLOSURE_LINKS,
  PARTNER_DETAILS_PENDING,
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
}

export function buildReceiptDisclosure(t: ReceiptTransfer, d: ResolvedDisclosure, nowMs: number): ReceiptDisclosure | null {
  if (t.transferType === 'b2b') return null;
  const paidMs = t.paidAt ? Date.parse(t.paidAt) : NaN;
  const deliveredMs = t.deliveredAt ? Date.parse(t.deliveredAt) : NaN;
  const dateAvailable =
    t.status === 'delivered' && Number.isFinite(deliveredMs)
      ? `${DATE_AVAILABLE_DELIVERED_PREFIX} ${DATE_FMT.format(new Date(deliveredMs))}`
      : Number.isFinite(paidMs)
        ? dateAvailableOnOrAbout(DATE_FMT.format(addBusinessDays(paidMs, d.deliveryBusinessDays)))
        : dateAvailableEstimate(d.deliveryBusinessDays);
  // The window is keyed on paid_at, which markPaidIfInReview can move LATER
  // (customer-favourable). Shown only while a paid transfer is inside it.
  const deadlineMs = paidMs + CANCEL_WINDOW_MS;
  const cancelDeadline =
    t.status === 'paid' && Number.isFinite(paidMs) && nowMs < deadlineMs ? new Date(deadlineMs).toISOString() : null;
  return {
    version: DISCLOSURE_DRAFT_VERSION,
    lines: coreLines(
      {
        sourceAmount: t.amountSource,
        sourceFee: t.feeSource,
        sourceTotalCharge: t.totalChargeSource,
        sourceCurrency: t.sourceCurrency,
        destAmount: t.amountInr,
        destCurrency: t.destinationCurrency,
        fxRate: t.fxRate,
      },
      dateAvailable,
    ),
    thirdPartyFeeNote: THIRD_PARTY_FEE_STATEMENT,
    provider: providerBlock(d),
    rightsSummary: RIGHTS_SUMMARY,
    links: DISCLOSURE_LINKS,
    cancelDeadline,
    cfpb: CFPB_CONTACT,
  };
}

/**
 * The optional `disclosureVersion` on the pay POST: a bounded, version-shaped
 * id. Deliberately NOT equality with the current version — during a Rolling
 * Release an older page may post the previous id, and it must still be recorded.
 */
export function isDisclosureAckVersion(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(v);
}
