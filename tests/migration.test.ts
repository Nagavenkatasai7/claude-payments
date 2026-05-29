import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  backfillCustomersOnce,
  backfillCountryCurrencyOnce,
  backfillPartnersOnce,
  backfillSchedulesOnce,
  backfillSourceAmountsOnce,
  backfillCorridorComplianceOnce,
} from '@/lib/migration';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createScheduleStore } from '@/lib/schedule-store';
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
    const ps = createPartnerStore(redis);
    for (const phone of ['15551111111', '15552222222']) {
      await createTransfer(store, ps, {
        phone, amountSource: 100, sourceCurrency: 'USD', partnerId: 'default',
        recipientName: 'Mom', recipientPhone: '919876543210',
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
    const ps = createPartnerStore(redis);
    await createTransfer(store, ps, {
      phone: '15551111111', amountSource: 100, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
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
    const ps = createPartnerStore(redis);
    await createTransfer(store, ps, {
      phone: '15551111111', amountSource: 100, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
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
      partnerId: 'default' as const,
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

describe('backfillPartnersOnce', () => {
  it('seeds the Default Partner when no partner exists', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);
    const result = await backfillPartnersOnce(store, cs, ps);
    expect(result.defaultPartnerCreated).toBe(true);
    expect(result.skippedSentinel).toBe(false);
    const p = await ps.getPartner('default');
    expect(p?.name).toBe('SendHome Default');
    expect(p?.countries).toEqual(['US']);
    expect(p?.status).toBe('active');
  });

  it('does NOT recreate Default Partner if it already exists (preserves edits)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);
    // Pre-existing default with a custom name
    await ps.savePartner({
      id: 'default',
      name: 'Custom Renamed Default',
      countries: ['US', 'CA'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const result = await backfillPartnersOnce(store, cs, ps);
    expect(result.defaultPartnerCreated).toBe(false);
    const p = await ps.getPartner('default');
    expect(p?.name).toBe('Custom Renamed Default');  // unchanged
  });

  it('backfills partnerId on existing customers + transfers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);

    // Pre-P2 customer (missing partnerId)
    await redis.set('customer:15551111111', JSON.stringify({
      senderPhone: '15551111111',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await redis.sadd('customers:phones', '15551111111');

    // Pre-P2 transfer
    await redis.set('transfer:OLDPART1', JSON.stringify({
      id: 'OLDPART1',
      phone: '15551111111',
      amountUsd: 100,
      feeUsd: 1.99,
      totalChargeUsd: 101.99,
      fxRate: 85.2,
      amountInr: 8520,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared',
      complianceReasons: [],
      status: 'delivered',
      createdAt: '2026-04-01T00:00:00Z',
      sourceCountry: 'US',
      sourceCurrency: 'USD',
      destinationCountry: 'IN',
      destinationCurrency: 'INR',
    }));
    await redis.sadd('transfers:ids', 'OLDPART1');

    const result = await backfillPartnersOnce(store, cs, ps);
    expect(result.customersBackfilled).toBe(1);
    expect(result.transfersBackfilled).toBe(1);

    const rawC = JSON.parse((await redis.get('customer:15551111111'))!);
    expect(rawC.partnerId).toBe('default');
    const rawT = JSON.parse((await redis.get('transfer:OLDPART1'))!);
    expect(rawT.partnerId).toBe('default');
  });

  it('is idempotent — second call returns skippedSentinel: true and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ps = createPartnerStore(redis);
    const first = await backfillPartnersOnce(store, cs, ps);
    const second = await backfillPartnersOnce(store, cs, ps);
    expect(first.skippedSentinel).toBe(false);
    expect(second.skippedSentinel).toBe(true);
    expect(second.defaultPartnerCreated).toBe(false);
    expect(second.customersBackfilled).toBe(0);
    expect(second.transfersBackfilled).toBe(0);
  });
});

describe('backfillSchedulesOnce', () => {
  it('writes partnerId to every legacy schedule (from owning customer)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);

    // Owning customer with partnerId: 'acme'
    await cs.saveCustomer({
      senderPhone: '15551112222',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    // Legacy schedule, no partnerId on disk
    await redis.set('schedule:OLDSCH1', JSON.stringify({
      id: 'OLDSCH1',
      phone: '15551112222',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'OLDSCH1');

    const result = await backfillSchedulesOnce(store, ss);
    expect(result.schedulesBackfilled).toBe(1);
    expect(result.skippedSentinel).toBe(false);

    const raw = JSON.parse((await redis.get('schedule:OLDSCH1'))!);
    expect(raw.partnerId).toBe('acme');
  });

  it('falls back to default when owning customer is missing (defensive)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);
    await redis.set('schedule:OLDSCH2', JSON.stringify({
      id: 'OLDSCH2',
      phone: '15559999999',                // orphan phone — no Customer record
      amountUsd: 100,
      recipientName: 'X',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'x@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'OLDSCH2');

    await backfillSchedulesOnce(store, ss);
    const raw = JSON.parse((await redis.get('schedule:OLDSCH2'))!);
    expect(raw.partnerId).toBe('default');
  });

  it('is idempotent — second call returns skippedSentinel: true and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);
    const first = await backfillSchedulesOnce(store, ss);
    const second = await backfillSchedulesOnce(store, ss);
    expect(first.skippedSentinel).toBe(false);
    expect(second.skippedSentinel).toBe(true);
    expect(second.schedulesBackfilled).toBe(0);
  });

  it('does NOT overwrite an existing partnerId on a schedule', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);
    await cs.saveCustomer({
      senderPhone: '15551112222',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await redis.set('schedule:KEEPME', JSON.stringify({
      id: 'KEEPME',
      phone: '15551112222',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
      partnerId: 'beta',               // already explicit — must be preserved
    }));
    await redis.sadd('schedules:ids', 'KEEPME');

    await backfillSchedulesOnce(store, ss);
    const raw = JSON.parse((await redis.get('schedule:KEEPME'))!);
    expect(raw.partnerId).toBe('beta');
  });
});

describe('backfillCorridorComplianceOnce', () => {
  it('P5: backfillCorridorComplianceOnce is sentinel-guarded and leaves default untouched', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const def = await partnerStore.ensureDefaultPartner();
    const before = JSON.stringify(await redis.get('partner:default'));

    const first = await backfillCorridorComplianceOnce(store, partnerStore);
    expect(first.skippedSentinel).toBe(false);

    // default has no corridorCompliance → not re-saved → byte-for-byte identical
    const after = JSON.stringify(await redis.get('partner:default'));
    expect(after).toBe(before);
    const reloaded = await partnerStore.getPartner('default');
    expect(reloaded).toEqual(def);
    expect(reloaded?.corridorCompliance).toBeUndefined();

    // second pass is a no-op (sentinel already claimed)
    const second = await backfillCorridorComplianceOnce(store, partnerStore);
    expect(second.skippedSentinel).toBe(true);
  });

  it('P5: a partner WITH corridorCompliance is preserved by the re-save (spread)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    await partnerStore.savePartner({
      id: 'gb-co', name: 'GB Co', countries: ['US', 'GB'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      corridorCompliance: { GB: { velocityLimit: 9 } },
    });
    await backfillCorridorComplianceOnce(store, partnerStore);
    const reloaded = await partnerStore.getPartner('gb-co');
    expect(reloaded?.corridorCompliance?.GB?.velocityLimit).toBe(9);
  });
});

describe('backfillSourceAmountsOnce', () => {
  it('P4: persists source fields on transfers and is sentinel-guarded', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const ss = createScheduleStore(redis, createCustomerStore(redis, store));
    // Pre-P4 transfer (no source fields), persisted raw
    await redis.set('transfer:t1', JSON.stringify({
      id: 't1', phone: '1', amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99,
      fxRate: 85, amountInr: 8500, recipientName: 'A', recipientPhone: '919999999999',
      payoutMethod: 'upi', payoutDestination: 'a@upi', fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared', complianceReasons: [], status: 'paid',
      createdAt: '2026-01-01T00:00:00Z', sourceCountry: 'US', sourceCurrency: 'USD',
      destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    }));
    await redis.sadd('transfers:ids', 't1');

    const first = await backfillSourceAmountsOnce(store, ss);
    expect(first.skippedSentinel).toBe(false);
    expect(first.transfersBackfilled).toBe(1);

    const raw = JSON.parse((await redis.get('transfer:t1'))!);
    expect(raw.amountSource).toBe(100); // PERSISTED, not just lazy-filled in memory

    const second = await backfillSourceAmountsOnce(store, ss);
    expect(second.skippedSentinel).toBe(true);
  });
});
