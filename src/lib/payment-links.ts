import { randomBytes } from 'node:crypto';
import { isCleanName, NAME_MAX } from './untrusted-text';
import { isValidPhone, normalizePhone } from './phone';
import { CLIENT_REFERENCE_ERROR, isValidClientReference } from './order-references';
import { PURPOSE_LABELS, TRANSFER_PURPOSES } from './purpose-codes';
import { MAX_USD, MIN_USD, QuoteError, wouldBeFeeUsd } from './fx';
import type { TransferPurpose, TransferStatus } from './types';

// payment-links — Batch B2. The pure rules of a payment link: a partner makes one
// link per customer to pay an APPROVED payee an exact rupee amount (owner answer
// 7: the amount is in rupees, the customer sees the US dollar total and the rate
// before paying). The single create form and every CSV row (payment-link-bulk.ts)
// go through parseLinkInput, so the two can never disagree.
//
// No I/O here except the token's randomness.

/** Owner decision: a link expires 7 days after it is made. */
export const LINK_TTL_DAYS = 7;
const DAY_MS = 86_400_000;
/** A sanity bound on one link (₹1 crore); the USD band below is the real limit. */
export const LINK_AMOUNT_MAX_INR = 10_000_000;
/** Owner answer 8: a new customer can send at most $500 a day in the first 3 days. */
export const NEW_CUSTOMER_DAILY_USD = 500;

export const LINK_FUNDING_METHODS = ['bank_transfer', 'debit_card'] as const;
export type LinkFundingMethod = (typeof LINK_FUNDING_METHODS)[number];

export function isLinkFundingMethod(v: unknown): v is LinkFundingMethod {
  return v === 'bank_transfer' || v === 'debit_card';
}

export interface LinkInput {
  customerName: string;
  /** Digits only (normalizePhone). */
  customerPhone: string;
  amountInr: number;
  reference: string;
  purpose: TransferPurpose;
}

export type LinkField = 'name' | 'phone' | 'amount' | 'reference' | 'purpose';
export type LinkRaw = Partial<Record<LinkField, unknown>>;

export type LinkParse =
  | { ok: true; value: LinkInput; warnings: string[] }
  | { ok: false; errors: Partial<Record<LinkField, string>>; warnings: string[] };

export const FORMULA_ERROR = 'must not start with =, +, - or @ (spreadsheet formulas are refused).';
export const EXCEL_PHONE_ERROR =
  'This phone number was changed by Excel (for example 1.41E+10). Format the phone column as text and export the file again.';

/**
 * A cell a spreadsheet would run as a formula (CSV injection): it starts with
 * = + - @, or with a tab / carriage return before one. Pure.
 */
export function isFormulaLike(v: string): boolean {
  return /^[\t\r]*[=+\-@]/.test(v);
}

/** "1.41E+10" — what Excel shows (and exports) for a long number in a General column. */
export function isExcelMangledNumber(v: string): boolean {
  return /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(v.trim());
}

/** A whole or 2-decimal rupee amount; commas, spaces and a ₹ / INR / Rs marker are allowed. Null ⇒ invalid. */
export function parseInrAmount(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim().replace(/^(₹|inr|rs\.?)\s*/i, '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > LINK_AMOUNT_MAX_INR) return null;
  return Math.round(n * 100) / 100;
}

/** The purpose code, or its English label, any case. Null ⇒ not one of the eight. */
export function parsePurpose(v: unknown): TransferPurpose | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === '') return null;
  for (const p of TRANSFER_PURPOSES) {
    if (s === p || s === PURPOSE_LABELS[p].toLowerCase() || s.replace(/[\s-]+/g, '_') === p) return p;
  }
  return null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * Check one link's fields. `usdPerInr` (when the rate is known) adds the USD
 * checks: the estimate must sit inside the platform's $10–$2,999 per transfer,
 * and above $500 it WARNS (the new-customer cap may refuse it at payment).
 */
export function parseLinkInput(raw: LinkRaw, opts: { usdPerInr?: number } = {}): LinkParse {
  const errors: Partial<Record<LinkField, string>> = {};
  const warnings: string[] = [];

  const name = str(raw.name).trim();
  const phoneRaw = str(raw.phone).trim();
  const amountRaw = str(raw.amount).trim();
  const reference = str(raw.reference).trim();
  const purposeRaw = str(raw.purpose).trim();

  // CSV injection: every cell, before its own rule (a +phone is the one exception).
  if (isFormulaLike(name)) errors.name = `Name ${FORMULA_ERROR}`;
  if (isFormulaLike(amountRaw)) errors.amount = `Amount ${FORMULA_ERROR}`;
  if (isFormulaLike(reference)) errors.reference = `Reference ${FORMULA_ERROR}`;
  if (isFormulaLike(purposeRaw)) errors.purpose = `Purpose ${FORMULA_ERROR}`;
  if (isFormulaLike(phoneRaw) && !/^\+[\d\s().-]+$/.test(phoneRaw)) errors.phone = `Phone ${FORMULA_ERROR}`;

  if (!errors.name && !isCleanName(name, NAME_MAX)) {
    errors.name = name === '' ? 'Enter the customer name.' : `Enter a plain name of at most ${NAME_MAX} characters.`;
  }

  const phone = normalizePhone(phoneRaw);
  if (!errors.phone) {
    if (isExcelMangledNumber(phoneRaw)) errors.phone = EXCEL_PHONE_ERROR;
    else if (!/^[+\d\s().-]+$/.test(phoneRaw) || !isValidPhone(phone)) {
      errors.phone = 'Enter the phone with its country code (10 to 15 digits).';
    }
  }

  const amountInr = errors.amount ? null : parseInrAmount(amountRaw);
  if (!errors.amount && amountInr === null) {
    errors.amount = 'Enter the rupee amount (more than 0, at most 2 decimals).';
  }
  if (amountInr !== null && opts.usdPerInr !== undefined && Number.isFinite(opts.usdPerInr) && opts.usdPerInr > 0) {
    const usd = amountInr * opts.usdPerInr;
    if (usd < MIN_USD) errors.amount = `About ${fmtUsd(usd)}: a payment must be at least ${fmtUsd(MIN_USD)}.`;
    else if (usd > MAX_USD) errors.amount = `About ${fmtUsd(usd)}: a payment can be at most ${fmtUsd(MAX_USD)}.`;
    else if (usd > NEW_CUSTOMER_DAILY_USD) {
      warnings.push(
        `About ${fmtUsd(usd)}: above $${NEW_CUSTOMER_DAILY_USD}. A new customer can pay at most $${NEW_CUSTOMER_DAILY_USD} a day in their first 3 days, so this payment may be refused.`,
      );
    }
  }

  if (!errors.reference && !isValidClientReference(reference)) errors.reference = CLIENT_REFERENCE_ERROR.replace('client_reference', 'Reference');

  const purpose = errors.purpose ? null : parsePurpose(purposeRaw);
  if (!errors.purpose && purpose === null) {
    errors.purpose =
      purposeRaw === ''
        ? 'Choose the purpose of the payment.'
        : `Purpose must be one of: ${TRANSFER_PURPOSES.join(', ')}.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    value: { customerName: name, customerPhone: phone, amountInr: amountInr!, reference, purpose: purpose! },
    warnings,
  };
}

/** A new link token: 128 random bits, base64url (22 characters). No personal data. */
export function newLinkToken(): string {
  return randomBytes(16).toString('base64url');
}

export function isLinkTokenShape(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v);
}

export function linkExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + LINK_TTL_DAYS * DAY_MS);
}

export type LinkStatus = 'open' | 'used' | 'cancelled' | 'expired';

interface LinkState {
  status: LinkStatus;
  expiresAt: Date | string;
}

const expired = (l: LinkState, now: Date) => new Date(l.expiresAt).getTime() <= now.getTime();

/**
 * Can this link be paid now?
 *   open    — open and not expired: the first payment;
 *   resume  — already claimed by a payment (status used) whose transfer is not
 *             minted yet (a crash mid-mint) or still awaiting payment (the
 *             charge failed): the SAME customer may retry, and the claim makes
 *             it the same transfer;
 *   inactive — anything else: the one "no longer active" page.
 */
export function linkPayability(
  link: LinkState,
  transferStatus: TransferStatus | null | undefined,
  now: Date = new Date(),
): 'open' | 'resume' | 'inactive' {
  if (expired(link, now)) return 'inactive';
  if (link.status === 'open') return 'open';
  if (link.status === 'used' && (!transferStatus || transferStatus === 'awaiting_payment')) return 'resume';
  return 'inactive';
}

export type LinkDisplayStatus = 'open' | 'paid' | 'processing' | 'not_paid' | 'cancelled' | 'expired';

/** What the partner list shows for a link (and its transfer, once claimed). */
export function linkDisplayStatus(
  link: LinkState,
  transferStatus: TransferStatus | null | undefined,
  now: Date = new Date(),
): LinkDisplayStatus {
  if (link.status === 'cancelled') return 'cancelled';
  if (link.status === 'expired') return 'expired';
  if (link.status === 'open') return expired(link, now) ? 'expired' : 'open';
  if (transferStatus === 'paid' || transferStatus === 'delivered' || transferStatus === 'in_review') return 'paid';
  if (transferStatus === 'cancelled' || transferStatus === 'blocked') return 'not_paid';
  return 'processing';
}

export const LINK_STATUS_LABELS: Readonly<Record<LinkDisplayStatus, string>> = {
  open: 'Open',
  paid: 'Paid',
  processing: 'Payment started',
  not_paid: 'Not paid',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export interface LinkQuote {
  amountInr: number;
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The price of a link: the payee receives EXACTLY `amountInr`. The USD principal
 * is the rupees at the rate, rounded UP to the cent (never short-paying the
 * payee); the fee is the flat fee for the funding method (bank $1.99, debit card
 * $2.99; wouldBeFeeUsd — no first-transfer-free and no rewards on these
 * payments). Throws QuoteError outside $10–$2,999 or on a bad rate.
 */
export function linkQuote(amountInr: number, rate: { toInr: number }, fundingMethod: LinkFundingMethod): LinkQuote {
  if (!Number.isFinite(rate.toInr) || rate.toInr <= 0) throw new QuoteError('Invalid exchange rate; please try again.');
  if (!Number.isFinite(amountInr) || amountInr <= 0) throw new QuoteError('Please give a valid amount.');
  // 1e-9 absorbs float noise so an exact cent (8500 / 85 = 100) is not bumped up.
  const amountUsd = Math.ceil((amountInr / rate.toInr) * 100 - 1e-9) / 100;
  if (amountUsd < MIN_USD || amountUsd > MAX_USD) {
    throw new QuoteError(`Payments must be between $${MIN_USD} and $${MAX_USD}.`);
  }
  const feeUsd = wouldBeFeeUsd(amountUsd, fundingMethod);
  return { amountInr, amountUsd, feeUsd, totalChargeUsd: round2(amountUsd + feeUsd), fxRate: rate.toInr };
}
