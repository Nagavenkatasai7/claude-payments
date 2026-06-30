import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createB2bQuoteStore, resolveCheckoutBillQuote } from '@/lib/b2b-quote-store';
import { quoteCrossBorderBill, type CrossBorderBillQuote } from '@/lib/b2b-quote';
import { FALLBACK_FX_RATES } from '@/lib/rate';
import { finalizeCrossBorderBillPayment } from '@/lib/b2b-pay-finalize';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { B2bInvoice } from '@/lib/types';

// Plan 4 — the cross-border B2B money path. NON-CUSTODIAL invariants under test:
//  • the seller payout comes from the SELLER PROFILE, never buyer input;
//  • the mint is claim-first idempotent (a double-submit mints ONE transfer);
//  • sanctions screen BOTH parties — a hit blocks (no settlement);
//  • the checkout quote is locked + reused, and re-quotes on expiry.

// Buyer in the US (USD) pays an HK seller's 1,000 HKD bill.
const SELLER = {
  id: 's_hk1', partnerId: DEFAULT_PARTNER_ID, phone: '85291234567',
  businessName: 'Kowloon Design Co', country: 'HK' as const, currency: 'HKD' as const,
};
const SELLER_PAYOUT = 'HK|024|388|987654321';
const BUYER_PHONE = '15551112222'; // US → USD
const INVOICED_AMOUNT = 1000; // HKD (the fixed obligation)

/** The exact cross-border quote a USD buyer gets for the 1,000-HKD bill (offline FX). */
function computeQuote(): CrossBorderBillQuote {
  return quoteCrossBorderBill({
    invoicedAmount: INVOICED_AMOUNT,
    sellerCurrency: 'HKD',
    buyerCurrency: 'USD',
    rates: FALLBACK_FX_RATES.USD,
    sellerToUsd: FALLBACK_FX_RATES.HKD.toUsd,
    fundingMethod: 'bank_pull',
  });
}

async function buildStores() {
  const redis = fakeRedis();
  const db = await freshDb();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const partnerStore = createPartnerStore(db);
  const monthlyVolumeStore = createMonthlyVolumeStore(redis);
  return { redis, db, store, customerStore, partnerStore, monthlyVolumeStore };
}

type Stores = Awaited<ReturnType<typeof buildStores>>;

async function seedActiveSeller(stores: Stores, businessName = SELLER.businessName) {
  await stores.store.createSeller({ ...SELLER, businessName });
  // payout set + status 'active' atomically (the onboarding completion path).
  const activated = await stores.store.completeSellerOnboarding(
    SELLER.phone, DEFAULT_PARTNER_ID, SELLER_PAYOUT,
  );
  expect(activated?.status).toBe('active');
}

async function seedInvoice(stores: Stores, id = 'inv_xb'): Promise<string> {
  const inv: B2bInvoice = {
    id, partnerId: DEFAULT_PARTNER_ID, businessName: SELLER.businessName, buyerPhone: BUYER_PHONE,
    lineItems: [{ description: 'Design work', qty: 1, unitAmountUsd: 0 }],
    amountUsd: 0, currency: 'USD',
    sellerId: SELLER.id, invoicedAmount: INVOICED_AMOUNT, invoicedCurrency: 'HKD',
    status: 'unpaid', createdAt: new Date().toISOString(),
  };
  await stores.store.saveB2bInvoice(inv);
  return id;
}

async function seedBuyer(stores: Stores, fullName = 'Buyer Person') {
  const { customer } = await stores.customerStore.upsertOnFirstInbound(BUYER_PHONE);
  await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName });
}

function finalize(stores: Stores, invoiceId: string, quote = computeQuote()) {
  return finalizeCrossBorderBillPayment(
    {
      store: stores.store,
      customerStore: stores.customerStore,
      partnerStore: stores.partnerStore,
      monthlyVolumeStore: stores.monthlyVolumeStore,
      db: stores.db,
    },
    { invoiceId, quote, buyerCurrency: 'USD', buyerToUsd: 1, fundingToken: 'bankpull_test_token' },
  );
}

async function transferCount(stores: Stores): Promise<number> {
  const r = (await stores.db.execute(sql`SELECT count(*)::int AS n FROM transfers`)) as unknown as {
    rows: Array<{ n: number }>;
  };
  return r.rows[0].n;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('resolveCheckoutBillQuote — locked at checkout, reused, re-quoted on expiry', () => {
  it('first call computes + locks; a reload reuses the SAME locked quote (no re-compute)', async () => {
    let nowMs = 1_700_000_000_000;
    const store = createB2bQuoteStore(fakeRedis(), { now: () => nowMs });
    const compute = vi.fn(async () => computeQuote());

    const first = await resolveCheckoutBillQuote(store, 'inv1', compute);
    const second = await resolveCheckoutBillQuote(store, 'inv1', compute);

    expect(compute).toHaveBeenCalledTimes(1); // reused, not recomputed
    expect(second.buyerTotal).toBe(first.buyerTotal);
    expect(second.lockedAt).toBe(first.lockedAt);
  });

  it('re-quotes after the lock TTL expires', async () => {
    let nowMs = 1_700_000_000_000;
    const store = createB2bQuoteStore(fakeRedis(), { now: () => nowMs });
    const compute = vi.fn(async () => computeQuote());

    await resolveCheckoutBillQuote(store, 'inv1', compute);
    nowMs += 16 * 60 * 1000; // > 15-min TTL
    await resolveCheckoutBillQuote(store, 'inv1', compute);

    expect(compute).toHaveBeenCalledTimes(2); // expiry forced a re-quote
  });

  it('an invalid (stale-currency) lock is rejected and re-quoted', async () => {
    const store = createB2bQuoteStore(fakeRedis());
    const compute = vi.fn(async () => computeQuote());
    await resolveCheckoutBillQuote(store, 'inv1', compute);
    // A guard that rejects the existing lock forces a fresh compute.
    await resolveCheckoutBillQuote(store, 'inv1', compute, () => false);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

describe('finalizeCrossBorderBillPayment — the cross-border mint', () => {
  it('mints a bank_pull transfer with buyer source + seller destination + EXACT invoiced amount', async () => {
    const stores = await buildStores();
    await seedActiveSeller(stores);
    await seedBuyer(stores);
    const invoiceId = await seedInvoice(stores);

    const res = await finalize(stores, invoiceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const t = await stores.store.getTransfer(res.transferId);
    expect(t).not.toBeNull();
    expect(t!.fundingMethod).toBe('bank_pull');
    expect(t!.transferType).toBe('b2b');
    // Source = buyer; destination = seller; the seller nets the EXACT obligation.
    expect(t!.sourceCurrency).toBe('USD');
    expect(t!.destinationCurrency).toBe('HKD');
    expect(t!.destinationCountry).toBe('HK');
    expect(t!.amountInr).toBe(INVOICED_AMOUNT); // amountDest = invoicedAmount, exactly
    // Convention-consistent: amountSource = PRINCIPAL, totalChargeSource = full debit.
    expect(t!.amountSource).toBe(computeQuote().buyerPrincipal);
    expect(t!.feeSource).toBe(computeQuote().feeBuyer);
    expect(t!.totalChargeSource).toBe(computeQuote().buyerTotal); // principal + fee
    expect(t!.fxRate).toBe(computeQuote().fxRate);
    // Funding leg is the OPAQUE buyer token; the bill is linked.
    expect(t!.achTokenRef).toBe('bankpull_test_token');
    expect(t!.invoiceId).toBe(invoiceId);
    expect(t!.phone).toBe(BUYER_PHONE);
    expect(t!.recipientPhone).toBe(SELLER.phone);
  });

  it('SELLER PAYOUT comes from the seller PROFILE, never from buyer input', async () => {
    const stores = await buildStores();
    await seedActiveSeller(stores);
    await seedBuyer(stores);
    const invoiceId = await seedInvoice(stores);

    const res = await finalize(stores, invoiceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const decrypted = await stores.store.getTransferDecrypted(res.transferId);
    expect(decrypted!.payoutDestination).toBe(SELLER_PAYOUT); // the encrypted profile payout
    expect(decrypted!.recipientName).toBe(SELLER.businessName);
  });

  it('is claim-first idempotent: a double-submit mints exactly ONE transfer', async () => {
    const stores = await buildStores();
    await seedActiveSeller(stores);
    await seedBuyer(stores);
    const invoiceId = await seedInvoice(stores);

    const a = await finalize(stores, invoiceId);
    const b = await finalize(stores, invoiceId);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.transferId).toBe(a.transferId); // same transfer
    expect(await transferCount(stores)).toBe(1); // never double-minted
  });

  it('refuses when the seller is not active / has no payout (no transfer minted)', async () => {
    const stores = await buildStores();
    await stores.store.createSeller(SELLER); // pending, no payout
    await seedBuyer(stores);
    const invoiceId = await seedInvoice(stores);

    const res = await finalize(stores, invoiceId);
    expect(res).toMatchObject({ ok: false, error: 'seller_unavailable' });
    expect(await transferCount(stores)).toBe(0);
  });

  it('SANCTIONS fail-closed — a buyer with NO screenable name is refused (never minted unscreened)', async () => {
    const stores = await buildStores();
    await seedActiveSeller(stores);
    // A verified buyer (passes the KYB gate) but with NO legal name on file —
    // screenTransfer would skip the buyer screen, so we must refuse the mint.
    const { customer } = await stores.customerStore.upsertOnFirstInbound(BUYER_PHONE);
    await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: '' });
    const invoiceId = await seedInvoice(stores);

    const res = await finalize(stores, invoiceId);
    expect(res).toMatchObject({ ok: false, error: 'buyer_unscreened' });
    expect(await transferCount(stores)).toBe(0);
  });

  it('SANCTIONS — a watchlisted BUYER blocks settlement (mint is blocked, never cleared)', async () => {
    const stores = await buildStores();
    await seedActiveSeller(stores);
    await seedBuyer(stores, 'John Doe'); // on the watchlist
    const invoiceId = await seedInvoice(stores);

    const res = await finalize(stores, invoiceId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('blocked');
    const t = await stores.store.getTransfer(res.transferId!);
    expect(t!.status).toBe('blocked');
  });

  it('SANCTIONS — a watchlisted SELLER blocks settlement too', async () => {
    const stores = await buildStores();
    await seedActiveSeller(stores, 'Jane Roe'); // seller business on the watchlist
    await seedBuyer(stores);
    const invoiceId = await seedInvoice(stores);

    const res = await finalize(stores, invoiceId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('blocked');
  });
});
