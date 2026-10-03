import { isBillExpired } from './b2b-bill-expiry';
import { maskPhoneLast4 } from './mask';
import type { B2bInvoice, CurrencyCode } from './types';

// partner-invoices (lost-features A6): the PURE rules behind /partner/invoices, shared with the
// legacy /admin-dashboard/b2b actions through src/lib/b2b-invoice-ops.ts. No PII leaves this
// module: the buyer is ••••last4, and line-item text (the seller's free text) is never shown.

const INVOICE_ID = /^[A-Za-z0-9_-]{1,160}$/;

/** An invoice id from a form: the minted shapes (room for reissue chains), nothing else. */
export function isInvoiceId(v: unknown): v is string {
  return typeof v === 'string' && INVOICE_ID.test(v);
}

/**
 * The clone id of a reissue, derived from the source id: both dashboards and a double submit mint
 * the SAME id, and the repo's insert is idempotent on it, so a dead bill revives exactly once.
 */
export function reissueIdFor(id: string): string {
  return `reissue-${id}`;
}

export type InvoiceControl = 'void' | 'reissue';

/** The one lifecycle control a bill offers: void an unpaid bill, reissue a voided or disputed one. */
export function invoiceControl(inv: Pick<B2bInvoice, 'status'>): InvoiceControl | null {
  if (inv.status === 'unpaid') return 'void';
  if (inv.status === 'voided' || inv.status === 'disputed') return 'reissue';
  return null;
}

export interface InvoiceRow {
  id: string;
  seller: string;
  /** ••••last4 only. */
  buyer: string;
  amount: number;
  currency: CurrencyCode;
  status: B2bInvoice['status'];
  /** An unpaid bill past its life (b2b-bill-expiry.ts); it can no longer be paid. */
  expired: boolean;
  createdAt: string;
  paidAt?: string;
  control: InvoiceControl | null;
}

/** One masked table row. The fixed obligation (invoicedAmount/Currency) wins when present. */
export function invoiceRow(inv: B2bInvoice, now: Date): InvoiceRow {
  const crossBorder = inv.invoicedAmount !== undefined && inv.invoicedCurrency !== undefined;
  return {
    id: inv.id,
    seller: inv.businessName,
    buyer: maskPhoneLast4(inv.buyerPhone),
    amount: crossBorder ? inv.invoicedAmount! : inv.amountUsd,
    currency: crossBorder ? inv.invoicedCurrency! : inv.currency,
    status: inv.status,
    expired: isBillExpired(inv, now),
    createdAt: inv.createdAt,
    ...(inv.paidAt ? { paidAt: inv.paidAt } : {}),
    control: invoiceControl(inv),
  };
}
