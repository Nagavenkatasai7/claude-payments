import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backfillCustomersOnce } from '@/lib/migration';
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
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    await backfillCustomersOnce(store, cs);
    const c = await cs.getCustomer('15551111111');
    expect(c?.kycStatus).toBe('verified'); // unchanged
  });
});
