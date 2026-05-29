import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { createTransfer } from '@/lib/transfer-create';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

const PHONE = '15551234567';

afterEach(() => vi.restoreAllMocks());

describe('customer store', () => {
  it('getCustomer returns null when no record', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });

  it('saveCustomer + getCustomer round-trips', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const c = {
      senderPhone: PHONE,
      firstSeenAt: '2026-05-24T12:00:00Z',
      kycStatus: 'not_started' as const,
      senderCountry: 'US' as const,
      createdAt: '2026-05-24T12:00:00Z',
      updatedAt: '2026-05-24T12:00:00Z',
      partnerId: 'default' as const,
    };
    await cs.saveCustomer(c);
    expect(await cs.getCustomer(PHONE)).toEqual(c);
  });

  it('upsertOnFirstInbound creates a brand-new customer (wasCreated=true) when no transfers exist', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE);
    expect(wasCreated).toBe(true);
    expect(customer.kycStatus).toBe('not_started');
    expect(customer.senderPhone).toBe(PHONE);
    expect(new Date(customer.firstSeenAt).toString()).not.toBe('Invalid Date');
  });

  it('upsertOnFirstInbound is idempotent: second call returns existing record with wasCreated=false', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
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
    const store = createStore(redis);
    // Pre-existing transfer (e.g. from before this batch shipped)
    await createTransfer(store, {
      phone: PHONE,
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    // Ensure a measurable gap so firstSeenAt (transfer.createdAt) and
    // updatedAt (now) fall in different milliseconds on fast hardware.
    await new Promise((r) => setTimeout(r, 5));
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE);
    expect(wasCreated).toBe(false); // grandfathered, not a "real" new customer
    expect(customer.kycStatus).toBe('grandfathered');
    expect(customer.kycVerifiedAt).toBeDefined();
    // firstSeenAt anchored to the oldest existing transfer
    expect(customer.firstSeenAt).not.toBe(customer.updatedAt);
  });

  it('listCustomers returns every saved customer', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    await cs.upsertOnFirstInbound('15551111111');
    await cs.upsertOnFirstInbound('15552222222');
    const all = await cs.listCustomers();
    expect(all.map((c) => c.senderPhone).sort()).toEqual(['15551111111', '15552222222']);
  });

  it('returns null on JSON corruption rather than throwing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    await redis.set(`customer:${PHONE}`, 'not-json');
    const cs = createCustomerStore(redis, store);
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });
});

describe('customer-store P1: senderCountry', () => {
  it('upsertOnFirstInbound writes senderCountry: US on a brand-new customer', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer } = await cs.upsertOnFirstInbound('15550009999');
    expect(customer.senderCountry).toBe('US');
  });

  it('upsertOnFirstInbound writes senderCountry: US on a grandfathered customer', async () => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    await createTransfer(store, {
      phone: '15550008888',
      amountSource: 50,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer } = await cs.upsertOnFirstInbound('15550008888');
    expect(customer.senderCountry).toBe('US');
    expect(customer.kycStatus).toBe('grandfathered');
  });

  it('getCustomer fills missing senderCountry in-memory without persisting', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    // Manually write a customer record missing senderCountry (simulating pre-P1 data)
    await redis.set('customer:15550007777', JSON.stringify({
      senderPhone: '15550007777',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    const cs = createCustomerStore(redis, store);
    const c1 = await cs.getCustomer('15550007777');
    expect(c1?.senderCountry).toBe('US');
    // Verify NO persist happened — raw value in Redis still missing the field
    const raw = await redis.get('customer:15550007777');
    expect(JSON.parse(raw!).senderCountry).toBeUndefined();
  });
});

describe('customer-store P2: partnerId', () => {
  it('upsertOnFirstInbound writes partnerId: default on a brand-new customer', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer } = await cs.upsertOnFirstInbound('15550009999');
    expect(customer.partnerId).toBe('default');
  });

  it('upsertOnFirstInbound writes partnerId: default on a grandfathered customer', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    // Pre-seed an old transfer for this phone (simulating pre-P2 data) without
    // depending on createTransfer (Task 5 hasn't shipped yet).
    await redis.set('transfer:OLDGRAND', JSON.stringify({
      id: 'OLDGRAND', phone: '15550008888', amountUsd: 50, feeUsd: 1.99,
      totalChargeUsd: 51.99, fxRate: 85.2, amountInr: 4260,
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
      complianceReasons: [], status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
      sourceCountry: 'US', sourceCurrency: 'USD',
      destinationCountry: 'IN', destinationCurrency: 'INR',
      // Note: NO partnerId — simulates pre-P2 record
    }));
    await redis.sadd('transfers:ids', 'OLDGRAND');
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer } = await cs.upsertOnFirstInbound('15550008888');
    expect(customer.partnerId).toBe('default');
    expect(customer.kycStatus).toBe('grandfathered');
  });

  it('getCustomer fills missing partnerId in-memory without persisting', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    // Manually write a customer record missing partnerId (simulating pre-P2 data)
    await redis.set('customer:15550007777', JSON.stringify({
      senderPhone: '15550007777',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      senderCountry: 'US',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    const cs = createCustomerStore(redis, store);
    const c = await cs.getCustomer('15550007777');
    expect(c?.partnerId).toBe('default');
    // Verify NO persist happened
    const raw = await redis.get('customer:15550007777');
    expect(JSON.parse(raw!).partnerId).toBeUndefined();
  });
});
