import { describe, it, expect } from 'vitest';
import { invoiceControl, invoiceRow, isInvoiceId, reissueIdFor } from '@/lib/partner-invoices';
import type { B2bInvoice } from '@/lib/types';

// Lost-features A6: the pure rules behind /partner/invoices. Relative dates only.
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const inv = (o: Partial<B2bInvoice> = {}): B2bInvoice => ({
  id: 'inv_1',
  partnerId: 'pa',
  businessName: 'Seller Co',
  buyerPhone: '15550001111',
  lineItems: [{ description: 'Widgets for 15550001111', qty: 1, unitAmountUsd: 100 }],
  amountUsd: 100,
  currency: 'USD',
  status: 'unpaid',
  createdAt: daysAgo(1),
  ...o,
});

describe('isInvoiceId', () => {
  it('accepts the minted shapes, including reissue chains', () => {
    expect(isInvoiceId('inv_1')).toBe(true);
    expect(isInvoiceId('reissue-reissue-inv_1')).toBe(true);
    expect(isInvoiceId('a'.repeat(160))).toBe(true);
  });
  it('refuses traversal, spaces, empty, too long and non-strings', () => {
    for (const bad of ['../x', 'a b', '', 'a'.repeat(161), 'inv/1', null, undefined, 7]) {
      expect(isInvoiceId(bad), String(bad)).toBe(false);
    }
  });
});

describe('reissueIdFor', () => {
  it('is derived from the source id, so both dashboards and a double submit mint the same clone id', () => {
    expect(reissueIdFor('inv_1')).toBe('reissue-inv_1');
    expect(reissueIdFor('inv_1')).toBe(reissueIdFor('inv_1'));
  });
});

describe('invoiceControl', () => {
  it('void for unpaid; reissue for voided or disputed; nothing for paid', () => {
    expect(invoiceControl(inv({ status: 'unpaid' }))).toBe('void');
    expect(invoiceControl(inv({ status: 'voided' }))).toBe('reissue');
    expect(invoiceControl(inv({ status: 'disputed' }))).toBe('reissue');
    expect(invoiceControl(inv({ status: 'paid' }))).toBeNull();
  });
});

describe('invoiceRow', () => {
  it('masks the buyer and never carries line-item text or a 10-digit run', () => {
    const row = invoiceRow(inv(), now);
    expect(row).toMatchObject({ id: 'inv_1', seller: 'Seller Co', amount: 100, currency: 'USD', status: 'unpaid', expired: false, control: 'void' });
    expect(row.buyer).toContain('1111');
    expect(JSON.stringify(row)).not.toMatch(/\d{10}/);
    expect(JSON.stringify(row)).not.toContain('Widgets');
  });
  it('uses the invoiced obligation when present', () => {
    expect(invoiceRow(inv({ invoicedAmount: 9000, invoicedCurrency: 'INR' }), now)).toMatchObject({ amount: 9000, currency: 'INR' });
  });
  it('an unpaid bill past its life reads expired; expired bills can still be voided', () => {
    const row = invoiceRow(inv({ createdAt: daysAgo(31) }), now);
    expect(row).toMatchObject({ status: 'unpaid', expired: true, control: 'void' });
    expect(invoiceRow(inv({ status: 'paid', createdAt: daysAgo(90), paidAt: daysAgo(80) }), now)).toMatchObject({ expired: false, paidAt: daysAgo(80) });
  });
});
