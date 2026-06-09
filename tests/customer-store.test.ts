import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createTransfer } from '@/lib/transfer-create';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

const PHONE = '15551234567';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(() => vi.restoreAllMocks());

function mkStores(redis = fakeRedis()) {
  const store = createStore(redis, db);
  const cs = createCustomerStore(db, store);
  return { store, cs };
}

let n = 0;
function mkTransfer(over: Partial<Transfer> = {}): Transfer {
  n += 1;
  return {
    id: `T_${n}`, phone: PHONE, amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
    fxRate: 85.2, amountInr: 8520, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'delivered',
    createdAt: '2026-04-01T00:00:00.000Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 100, feeSource: 1.99, totalChargeSource: 101.99,
    ...over,
  } as Transfer;
}

describe('customer store', () => {
  it('getCustomer returns null when no record', async () => {
    const { cs } = mkStores();
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });

  it('saveCustomer + getCustomer round-trips', async () => {
    const { cs } = mkStores();
    const c = {
      senderPhone: PHONE,
      firstSeenAt: '2026-05-24T12:00:00.000Z',
      kycStatus: 'not_started' as const,
      senderCountry: 'US' as const,
      createdAt: '2026-05-24T12:00:00.000Z',
      updatedAt: '2026-05-24T12:00:00.000Z',
      partnerId: 'default' as const,
    };
    await cs.saveCustomer(c);
    expect(await cs.getCustomer(PHONE)).toEqual(c);
  });

  it('upsertOnFirstInbound creates a brand-new customer (wasCreated=true) when no transfers exist', async () => {
    const { cs } = mkStores();
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE);
    expect(wasCreated).toBe(true);
    expect(customer.kycStatus).toBe('not_started');
    expect(customer.senderPhone).toBe(PHONE);
    expect(new Date(customer.firstSeenAt).toString()).not.toBe('Invalid Date');
  });

  it('upsertOnFirstInbound is idempotent: second call returns existing record with wasCreated=false', async () => {
    const { cs } = mkStores();
    const first = await cs.upsertOnFirstInbound(PHONE);
    const second = await cs.upsertOnFirstInbound(PHONE);
    expect(second.wasCreated).toBe(false);
    expect(second.customer.firstSeenAt).toBe(first.customer.firstSeenAt);
  });

  it('upsertOnFirstInbound grandfathers a phone with existing transfers (wasCreated=false)', async () => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const ps = createPartnerStore(db);
    const mvs = createMonthlyVolumeStore(redis);
    // Pre-existing transfer (e.g. from before this batch shipped)
    await createTransfer(store, ps, mvs, {
      phone: PHONE,
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified',
    });
    // Ensure a measurable gap so firstSeenAt (transfer.createdAt) and
    // updatedAt (now) fall in different milliseconds on fast hardware.
    await new Promise((r) => setTimeout(r, 5));
    const cs = createCustomerStore(db, store);
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE);
    expect(wasCreated).toBe(false); // grandfathered, not a "real" new customer
    expect(customer.kycStatus).toBe('grandfathered');
    expect(customer.kycVerifiedAt).toBeDefined();
    // firstSeenAt anchored to the oldest existing transfer
    expect(customer.firstSeenAt).not.toBe(customer.updatedAt);
  });

  it('listCustomers returns every saved customer', async () => {
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound('15551111111');
    await cs.upsertOnFirstInbound('15552222222');
    const all = await cs.listCustomers();
    expect(all.map((c) => c.senderPhone).sort()).toEqual(['15551111111', '15552222222']);
  });
});

describe('customer-store P1: senderCountry', () => {
  it('upsertOnFirstInbound writes senderCountry: US on a brand-new customer', async () => {
    const { cs } = mkStores();
    const { customer } = await cs.upsertOnFirstInbound('15550009999');
    expect(customer.senderCountry).toBe('US');
  });

  it('upsertOnFirstInbound writes senderCountry: US on a grandfathered customer', async () => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const ps = createPartnerStore(db);
    const mvs = createMonthlyVolumeStore(redis);
    await createTransfer(store, ps, mvs, {
      phone: '15550008888',
      amountSource: 50,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified',
    });
    const cs = createCustomerStore(db, store);
    const { customer } = await cs.upsertOnFirstInbound('15550008888');
    expect(customer.senderCountry).toBe('US');
    expect(customer.kycStatus).toBe('grandfathered');
  });
});

describe('customer-store multicountry: senderCountry inferred from phone', () => {
  it('AE phone (971...) → senderCountry AE', async () => {
    const { cs } = mkStores();
    const { customer } = await cs.upsertOnFirstInbound('971501234567');
    expect(customer.senderCountry).toBe('AE');
  });

  it('GB phone (44...) → senderCountry GB', async () => {
    const { cs } = mkStores();
    const { customer } = await cs.upsertOnFirstInbound('447911123456');
    expect(customer.senderCountry).toBe('GB');
  });

  it('US phone (1...) → senderCountry US', async () => {
    const { cs } = mkStores();
    const { customer } = await cs.upsertOnFirstInbound('15551234567');
    expect(customer.senderCountry).toBe('US');
  });

  it('unknown calling code (886...) → senderCountry falls back to DEFAULT_SENDER_COUNTRY (US)', async () => {
    const { cs } = mkStores();
    const { customer } = await cs.upsertOnFirstInbound('886123456');
    expect(customer.senderCountry).toBe('US');
  });

  it('AE phone on grandfathered path → senderCountry AE', async () => {
    const { store, cs } = mkStores();
    // Seed an existing transfer row for this phone (born complete in Postgres)
    await store.saveTransfer(mkTransfer({
      id: 'AETRANSFER', phone: '971509999999', amountUsd: 200, feeUsd: 2,
      totalChargeUsd: 202, fxRate: 85, amountInr: 17000,
      recipientName: 'Cousin', payoutDestination: 'cousin@upi',
      sourceCountry: 'AE', sourceCurrency: 'AED',
      amountSource: 200, feeSource: 2, totalChargeSource: 202,
    }));
    const { customer } = await cs.upsertOnFirstInbound('971509999999');
    expect(customer.senderCountry).toBe('AE');
    expect(customer.kycStatus).toBe('grandfathered');
  });
});

describe('recordFundingMethod (Bundle C sticky funding)', () => {
  it('persists lastFundingMethod + lastFundingMethodAt on an existing customer', async () => {
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound(PHONE); // creates the customer record
    await cs.recordFundingMethod(PHONE, 'credit_card');
    const c = await cs.getCustomer(PHONE);
    expect(c?.lastFundingMethod).toBe('credit_card');
    expect(typeof c?.lastFundingMethodAt).toBe('string');
  });
  it('is a no-op when there is no customer record yet', async () => {
    const { cs } = mkStores();
    await cs.recordFundingMethod(PHONE, 'bank_transfer'); // must not throw
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });
});

describe('customer-store Item 4: consent (optInAt / optedOutAt)', () => {
  it('upsertOnFirstInbound sets optInAt on a brand-new customer', async () => {
    const { cs } = mkStores();
    const { customer } = await cs.upsertOnFirstInbound(PHONE);
    expect(customer.optInAt).toBeDefined();
    expect(new Date(customer.optInAt!).toString()).not.toBe('Invalid Date');
  });

  it('upsertOnFirstInbound PERSISTS optInAt for an EXISTING pre-feature record (Fix 5)', async () => {
    // Prod bug: a returning customer whose record predates optInAt would hit the
    // `if (existing) return` fast path and never get optInAt persisted. The store
    // must backfill-and-persist it itself (first-contact-wins), not rely on the
    // route remembering to call setOptedIn.
    const { cs } = mkStores();
    // Save a record with NO optInAt (simulating a pre-feature/grandfathered row)
    await cs.saveCustomer({
      senderPhone: PHONE,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE);
    expect(wasCreated).toBe(false); // still an existing record, not a fresh create
    expect(customer.optInAt).toBeDefined();
    // And it is actually PERSISTED (not just filled in-memory)
    const persisted = await cs.getCustomer(PHONE);
    expect(persisted?.optInAt).toBeDefined();
  });

  it('upsertOnFirstInbound does NOT churn optInAt on an existing record that already has it (Fix 5 idempotent)', async () => {
    const { cs } = mkStores();
    const existingOptIn = '2026-02-02T00:00:00.000Z';
    await cs.saveCustomer({
      senderPhone: PHONE,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'default',
      optInAt: existingOptIn,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { customer } = await cs.upsertOnFirstInbound(PHONE);
    expect(customer.optInAt).toBe(existingOptIn); // first contact wins, untouched
  });

  it('setOptedIn sets optInAt once and is idempotent (first contact wins)', async () => {
    const { cs } = mkStores();
    // start from a record with NO optInAt (simulate a grandfathered/pre-feature record)
    await cs.saveCustomer({
      senderPhone: PHONE,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await cs.setOptedIn(PHONE);
    const first = (await cs.getCustomer(PHONE))!.optInAt;
    expect(first).toBeDefined();
    await new Promise((r) => setTimeout(r, 3));
    await cs.setOptedIn(PHONE); // second call must NOT overwrite
    const second = (await cs.getCustomer(PHONE))!.optInAt;
    expect(second).toBe(first);
  });

  it('setOptedOut sets optedOutAt', async () => {
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound(PHONE);
    await cs.setOptedOut(PHONE);
    expect((await cs.getCustomer(PHONE))?.optedOutAt).toBeDefined();
  });

  it('clearOptedOut removes optedOutAt (undefined)', async () => {
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound(PHONE);
    await cs.setOptedOut(PHONE);
    expect((await cs.getCustomer(PHONE))?.optedOutAt).toBeDefined();
    await cs.clearOptedOut(PHONE);
    expect((await cs.getCustomer(PHONE))?.optedOutAt).toBeUndefined();
  });

  it('setOptedIn / setOptedOut / clearOptedOut are no-ops when no customer exists', async () => {
    const { cs } = mkStores();
    await cs.setOptedIn(PHONE); // must not throw
    await cs.setOptedOut(PHONE);
    await cs.clearOptedOut(PHONE);
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });
});

describe('customer-store P2: partnerId', () => {
  it('upsertOnFirstInbound writes partnerId: default on a brand-new customer', async () => {
    const { cs } = mkStores();
    const { customer } = await cs.upsertOnFirstInbound('15550009999');
    expect(customer.partnerId).toBe('default');
  });

  it('upsertOnFirstInbound writes partnerId: default on a grandfathered customer', async () => {
    const { store, cs } = mkStores();
    // Pre-seed an old transfer for this phone (rows are born complete in
    // Postgres — partnerId 'default' is the auto-seeded FK target).
    await store.saveTransfer(mkTransfer({
      id: 'OLDGRAND', phone: '15550008888', amountUsd: 50, feeUsd: 1.99,
      totalChargeUsd: 51.99, amountInr: 4260,
      amountSource: 50, feeSource: 1.99, totalChargeSource: 51.99,
    }));
    const { customer } = await cs.upsertOnFirstInbound('15550008888');
    expect(customer.partnerId).toBe('default');
    expect(customer.kycStatus).toBe('grandfathered');
  });
});

describe('WL2 follow-the-number routing (upsertOnFirstInbound + routedPartnerId)', () => {
  it('creates a NEW customer under the routed partner', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE, 'acme');
    expect(wasCreated).toBe(true);
    expect(customer.partnerId).toBe('acme');
  });

  it('MOVES an existing default-partner customer to the partner that owns the number', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound(PHONE); // created under 'default'
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE, 'acme');
    expect(wasCreated).toBe(false);
    expect(customer.partnerId).toBe('acme');
    // persisted, not just in-memory
    expect((await cs.getCustomer(PHONE))!.partnerId).toBe('acme');
  });

  it('no routedPartnerId ⇒ existing customer keeps their partner (no churn)', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    await cs.upsertOnFirstInbound(PHONE, 'acme');
    const { customer } = await cs.upsertOnFirstInbound(PHONE);
    expect(customer.partnerId).toBe('acme');
  });

  it('same routedPartnerId ⇒ idempotent (no extra write needed)', async () => {
    await seedPartner(db, 'acme');
    const { cs } = mkStores();
    const first = await cs.upsertOnFirstInbound(PHONE, 'acme');
    const second = await cs.upsertOnFirstInbound(PHONE, 'acme');
    expect(second.customer.updatedAt).toBe(first.customer.updatedAt);
  });
});
