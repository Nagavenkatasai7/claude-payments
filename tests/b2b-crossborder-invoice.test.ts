import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb } from './helpers-db';
import { createB2bInvoiceRepo, createSellerRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { B2bInvoice } from '@/lib/types';
import type { Db } from '@/db/client';

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const seller = {
  id: 's_hk', partnerId: DEFAULT_PARTNER_ID, phone: '85291234567',
  businessName: 'Kowloon Design Co', country: 'HK' as const, currency: 'HKD' as const,
};

describe('createB2bInvoiceRepo — cross-border invoice model (Plan 3)', () => {
  it('round-trips sellerId + invoicedAmount + invoicedCurrency (PGlite, partner-scoped)', async () => {
    await createSellerRepo(db).createSeller(seller);
    const repo = createB2bInvoiceRepo(db);
    const inv: B2bInvoice = {
      id: 'inv_xb', partnerId: DEFAULT_PARTNER_ID, businessName: 'Kowloon Design Co', buyerPhone: '15551112222',
      lineItems: [{ description: 'Design work', qty: 1, unitAmountUsd: 0 }],
      amountUsd: 0, currency: 'USD',
      sellerId: 's_hk', invoicedAmount: 1000, invoicedCurrency: 'HKD',
      status: 'unpaid', createdAt: '2026-06-25T00:00:00.000Z',
    };
    await repo.saveInvoice(inv);

    const got = await repo.getInvoiceByIdScoped('inv_xb', DEFAULT_PARTNER_ID);
    expect(got?.sellerId).toBe('s_hk');
    expect(got?.invoicedAmount).toBe(1000);
    expect(got?.invoicedCurrency).toBe('HKD');
    // Tenant isolation: another partner can't read it.
    expect(await repo.getInvoiceByIdScoped('inv_xb', 'other')).toBeNull();
    // The unpaid-by-buyer lookup carries the cross-border fields too.
    const byBuyer = await repo.getUnpaidByBuyer('15551112222', DEFAULT_PARTNER_ID);
    expect(byBuyer?.invoicedAmount).toBe(1000);
    expect(byBuyer?.invoicedCurrency).toBe('HKD');
  });

  it('a legacy US-domestic invoice (no cross-border fields) still works unchanged', async () => {
    const repo = createB2bInvoiceRepo(db);
    const inv: B2bInvoice = {
      id: 'inv_legacy', partnerId: DEFAULT_PARTNER_ID, businessName: 'Globex Trading LLC', buyerPhone: '15551112222',
      lineItems: [{ description: 'Widgets', qty: 100, unitAmountUsd: 10 }],
      amountUsd: 1000, currency: 'USD', status: 'unpaid', createdAt: '2026-06-25T00:00:00.000Z',
    };
    await repo.saveInvoice(inv);

    const got = await repo.getInvoice('inv_legacy');
    expect(got?.amountUsd).toBe(1000);
    expect(got?.currency).toBe('USD');
    // No cross-border fields leak onto a domestic bill.
    expect(got?.sellerId).toBeUndefined();
    expect(got?.invoicedAmount).toBeUndefined();
    expect(got?.invoicedCurrency).toBeUndefined();

    // Existing lifecycle (mark paid) is unaffected.
    await repo.markPaid('inv_legacy', '2026-06-25T01:00:00.000Z');
    expect((await repo.getInvoice('inv_legacy'))?.status).toBe('paid');
  });

  it('reissue carries the cross-border obligation to the fresh bill', async () => {
    await createSellerRepo(db).createSeller(seller);
    const repo = createB2bInvoiceRepo(db);
    await repo.saveInvoice({
      id: 'inv_src', partnerId: DEFAULT_PARTNER_ID, businessName: 'Kowloon Design Co', buyerPhone: '15551112222',
      lineItems: [{ description: 'Design work', qty: 1, unitAmountUsd: 0 }],
      amountUsd: 0, currency: 'USD', sellerId: 's_hk', invoicedAmount: 1000, invoicedCurrency: 'HKD',
      status: 'unpaid', createdAt: '2026-06-25T00:00:00.000Z',
    });
    await repo.voidInvoice('inv_src', DEFAULT_PARTNER_ID);

    const reissued = await repo.reissueInvoice('inv_src', DEFAULT_PARTNER_ID, 'inv_fresh');
    expect(reissued?.status).toBe('unpaid');
    expect(reissued?.sellerId).toBe('s_hk');
    expect(reissued?.invoicedAmount).toBe(1000);
    expect(reissued?.invoicedCurrency).toBe('HKD');
  });
});
