import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createSellerRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { B2bInvoice } from '@/lib/types';
import type { Db } from '@/db/client';

/**
 * Program-Fix 44 (P3, b2b-04) — store reads that honour the bill TTL:
 *   • getUnpaidInvoiceByBuyer (the bot's present_bill / dispute_bill lookup)
 *     never surfaces an unpaid bill older than B2B_BILL_TTL_DAYS;
 *   • findOpenTwinInvoice is the DURABLE duplicate-bill check create_invoice
 *     runs before its 120 s Redis claim (same tenant + seller + buyer + amount
 *     + currency, still unpaid, not expired);
 *   • listAllB2bInvoices is the platform dashboard's cross-tenant list.
 */

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();

let db: Db;
let store: ReturnType<typeof createStore>;

function inv(over: Partial<B2bInvoice> & { id: string }): B2bInvoice {
  return {
    partnerId: DEFAULT_PARTNER_ID,
    businessName: 'Seller Co',
    buyerPhone: '15550002222',
    lineItems: [{ description: 'Work', qty: 1, unitAmountUsd: 500 }],
    amountUsd: 500,
    currency: 'USD',
    status: 'unpaid',
    createdAt: daysAgo(1),
    ...over,
  };
}

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
});

describe('getUnpaidInvoiceByBuyer applies the bill TTL (Program-Fix 44)', { retry: 0 }, () => {
  it('an unpaid bill 31 days old is not surfaced', async () => {
    await store.saveB2bInvoice(inv({ id: 'inv_old', createdAt: daysAgo(31) }));
    expect(await store.getUnpaidInvoiceByBuyer('15550002222', DEFAULT_PARTNER_ID)).toBeNull();
  });

  it('a 29-day-old bill is still surfaced', async () => {
    await store.saveB2bInvoice(inv({ id: 'inv_29', createdAt: daysAgo(29) }));
    expect((await store.getUnpaidInvoiceByBuyer('15550002222', DEFAULT_PARTNER_ID))?.id).toBe('inv_29');
  });

  it('with an expired and a live bill, the live one is surfaced', async () => {
    await store.saveB2bInvoice(inv({ id: 'inv_live', createdAt: daysAgo(2) }));
    await store.saveB2bInvoice(inv({ id: 'inv_old', createdAt: daysAgo(40) }));
    expect((await store.getUnpaidInvoiceByBuyer('15550002222', DEFAULT_PARTNER_ID))?.id).toBe('inv_live');
  });
});

describe('findOpenTwinInvoice — durable duplicate-bill check (Program-Fix 44)', { retry: 0 }, () => {
  beforeEach(async () => {
    await seedPartner(db, 'tenant_b');
    await createSellerRepo(db).createSeller({
      id: 's_1', partnerId: DEFAULT_PARTNER_ID, phone: '15550009999',
      businessName: 'Seller Co', country: 'US', currency: 'USD',
    });
  });
  const twin = (over: Partial<B2bInvoice> & { id: string }) =>
    inv({ sellerId: 's_1', invoicedAmount: 500, invoicedCurrency: 'USD', ...over });
  const query = {
    partnerId: DEFAULT_PARTNER_ID, sellerId: 's_1', buyerPhone: '15550002222',
    invoicedAmount: 500, invoicedCurrency: 'USD' as const,
  };

  it('finds a live unpaid twin', async () => {
    await store.saveB2bInvoice(twin({ id: 'inv_twin' }));
    expect((await store.findOpenTwinInvoice(query))?.id).toBe('inv_twin');
  });

  it('matches a formatted buyer phone (normalized like the write)', async () => {
    await store.saveB2bInvoice(twin({ id: 'inv_twin' }));
    expect((await store.findOpenTwinInvoice({ ...query, buyerPhone: '+1 555 000 2222' }))?.id).toBe('inv_twin');
  });

  it('ignores a paid, voided or disputed twin (a paid retainer can repeat)', async () => {
    await store.saveB2bInvoice(twin({ id: 'inv_paid', status: 'paid' }));
    await store.saveB2bInvoice(twin({ id: 'inv_void', status: 'voided' }));
    await store.saveB2bInvoice(twin({ id: 'inv_disp', status: 'disputed' }));
    expect(await store.findOpenTwinInvoice(query)).toBeNull();
  });

  it('ignores an EXPIRED unpaid twin (a dead bill never blocks a new one)', async () => {
    await store.saveB2bInvoice(twin({ id: 'inv_dead', createdAt: daysAgo(31) }));
    expect(await store.findOpenTwinInvoice(query)).toBeNull();
  });

  it('a different amount, currency, buyer, seller or tenant is not a twin', async () => {
    await store.saveB2bInvoice(twin({ id: 'inv_twin' }));
    expect(await store.findOpenTwinInvoice({ ...query, invoicedAmount: 500.01 })).toBeNull();
    expect(await store.findOpenTwinInvoice({ ...query, invoicedCurrency: 'MXN' })).toBeNull();
    expect(await store.findOpenTwinInvoice({ ...query, buyerPhone: '15550003333' })).toBeNull();
    expect(await store.findOpenTwinInvoice({ ...query, sellerId: 's_other' })).toBeNull();
    expect(await store.findOpenTwinInvoice({ ...query, partnerId: 'tenant_b' })).toBeNull();
  });
});

describe('listAllB2bInvoices — platform cross-tenant list (Program-Fix 44)', { retry: 0 }, () => {
  it('lists every tenant, newest first', async () => {
    await seedPartner(db, 'tenant_b');
    await store.saveB2bInvoice(inv({ id: 'inv_def', createdAt: daysAgo(3) }));
    await store.saveB2bInvoice(inv({ id: 'inv_b', partnerId: 'tenant_b', createdAt: daysAgo(1) }));
    const all = await store.listAllB2bInvoices();
    expect(all.map((i) => i.id)).toEqual(['inv_b', 'inv_def']);
  });
});

describe('claimBillResendToken — replay-stable re-send token (Program-Fix 44 r1)', { retry: 0 }, () => {
  it('the first claim binds the candidate; a replay reads the SAME token back; another bill is independent', async () => {
    expect(await store.claimBillResendToken('inv_x', 't1')).toBe('t1');
    expect(await store.claimBillResendToken('inv_x', 't2')).toBe('t1');
    expect(await store.claimBillResendToken('inv_y', 't3')).toBe('t3');
  });
});
