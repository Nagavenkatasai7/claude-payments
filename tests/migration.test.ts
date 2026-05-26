import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backfillCustomersOnce, backfillCountryCurrencyOnce } from '@/lib/migration';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransfer } from '@/lib/transfer-create';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ rates: { INR: 85.2 } }),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('backfillCustomersOnce', () => {
  it('creates grandfathered customers for every phone with transfers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    for (const phone of ['15551111111', '15552222222']) {
      await createTransfer(store, {
        phone, amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
        payoutMethod: 'upi', payoutDestination: 'm@upi', fundingMethod: 'bank_transfer',
      });
    }
    const result = await backfillCustomersOnce(store, cs);
    expect(result.backfilled).toBe(2);
    const all = await cs.listCustomers();
    expect(all.every((c) => c.kycStatus === 'grandfathered')).toBe(true);
    expect(all.map((c) => c.senderPhone).sort()).toEqual(['15551111111', '15552222222']);
  });

  it('is idempotent — second call returns backfilled=0 and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    await createTransfer(store, {
      phone: '15551111111', amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'm@upi', fundingMethod: 'bank_transfer',
    });
    const first = await backfillCustomersOnce(store, cs);
    const second = await backfillCustomersOnce(store, cs);
    expect(first.backfilled).toBe(1);
    expect(second.backfilled).toBe(0);
    expect(second.skippedSentinel).toBe(true);
  });

  it('does not overwrite an existing Customer record', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    await createTransfer(store, {
      phone: '15551111111', amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'm@upi', fundingMethod: 'bank_transfer',
    });
    // Pre-existing customer record (e.g. lazy backfill from webhook ran first)
    await cs.saveCustomer({
      senderPhone: '15551111111',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-02T00:00:00Z',
      senderCountry: 'US' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    await backfillCustomersOnce(store, cs);
    const c = await cs.getCustomer('15551111111');
    expect(c?.kycStatus).toBe('verified'); // unchanged
  });
});

describe('backfillCountryCurrencyOnce', () => {
  it('writes senderCountry to every customer missing it', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    // Pre-P1 customers (missing senderCountry)
    await redis.set('customer:15551111111', JSON.stringify({
      senderPhone: '15551111111',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15551111111');
    await redis.set('customer:15552222222', JSON.stringify({
      senderPhone: '15552222222',
      firstSeenAt: '2026-01-02T00:00:00Z',
      kycStatus: 'grandfathered',
      kycVerifiedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15552222222');

    const result = await backfillCountryCurrencyOnce(store, cs);
    expect(result.customersBackfilled).toBe(2);
    expect(result.skippedSentinel).toBe(false);

    // Verify Redis raw values now have senderCountry
    const raw1 = JSON.parse((await redis.get('customer:15551111111'))!);
    const raw2 = JSON.parse((await redis.get('customer:15552222222'))!);
    expect(raw1.senderCountry).toBe('US');
    expect(raw2.senderCountry).toBe('US');
  });

  it('writes 4 fields to every transfer missing them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);

    // Manually write pre-P1 transfers
    await redis.set('transfer:OLDAAA', JSON.stringify({
      id: 'OLDAAA',
      phone: '15551111111',
      amountUsd: 50,
      feeUsd: 1.99,
      totalChargeUsd: 51.99,
      fxRate: 85.2,
      amountInr: 4260,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('transfers:ids', 'OLDAAA');

    const result = await backfillCountryCurrencyOnce(store, cs);
    expect(result.transfersBackfilled).toBe(1);

    const raw = JSON.parse((await redis.get('transfer:OLDAAA'))!);
    expect(raw.sourceCountry).toBe('US');
    expect(raw.sourceCurrency).toBe('USD');
    expect(raw.destinationCountry).toBe('IN');
    expect(raw.destinationCurrency).toBe('INR');
  });

  it('is idempotent — second call returns skippedSentinel: true and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    await redis.set('customer:15553333333', JSON.stringify({
      senderPhone: '15553333333',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15553333333');

    const first = await backfillCountryCurrencyOnce(store, cs);
    const second = await backfillCountryCurrencyOnce(store, cs);
    expect(first.customersBackfilled).toBe(1);
    expect(first.skippedSentinel).toBe(false);
    expect(second.customersBackfilled).toBe(0);
    expect(second.transfersBackfilled).toBe(0);
    expect(second.skippedSentinel).toBe(true);
  });

  it('does NOT overwrite existing senderCountry values (preserves CA)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    // Customer already has senderCountry: 'CA'
    await redis.set('customer:15554444444', JSON.stringify({
      senderPhone: '15554444444',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'CA',  // already set
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15554444444');

    await backfillCountryCurrencyOnce(store, cs);
    const raw = JSON.parse((await redis.get('customer:15554444444'))!);
    expect(raw.senderCountry).toBe('CA'); // unchanged
  });
});
