import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }),
  );
});
afterEach(() => vi.restoreAllMocks());

const base = {
  phone: '15551234567',
  amountSource: 200,
  sourceCurrency: 'USD' as const,
  partnerId: 'default',
  recipientName: 'Mom',
  recipientPhone: '919133001840',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
};

describe('createTransfer', () => {
  it('creates a cleared transfer in awaiting_payment', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const t = await createTransfer(store, partnerStore, base);
    expect(t.status).toBe('awaiting_payment');
    expect(t.complianceStatus).toBe('cleared');
    expect(await store.getTransfer(t.id)).not.toBeNull();
  });

  it('blocks a watchlisted recipient and sets status blocked', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const t = await createTransfer(store, partnerStore, { ...base, recipientName: 'John Doe' });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.status).toBe('blocked');
  });

  it('flags a large amount but stays awaiting_payment', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const t = await createTransfer(store, partnerStore, { ...base, amountSource: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.status).toBe('awaiting_payment');
  });

  it('increments the all-time and today counters', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    await createTransfer(store, partnerStore, base);
    expect(await store.getTransferCount(base.phone)).toBe(1);
    expect(await store.getTodayTransferCount(base.phone)).toBe(1);
  });
});

describe('createTransfer P1: country + currency fields', () => {
  it('populates all 4 new fields with defaults', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const t = await createTransfer(store, partnerStore, {
      phone: '15551112222',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    expect(t.sourceCountry).toBe('US');
    expect(t.sourceCurrency).toBe('USD');
    expect(t.destinationCountry).toBe('IN');
    expect(t.destinationCurrency).toBe('INR');
  });
});

describe('createTransfer P2: partnerId', () => {
  it('populates partnerId: default on new transfers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const t = await createTransfer(store, partnerStore, {
      phone: '15551112222',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    expect(t.partnerId).toBe('default');
  });
});

describe('createTransfer P4: source-currency fields', () => {
  it('P4: populates source-currency fields (USD scaffold) from the quote', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const t = await createTransfer(store, partnerStore, {
      phone: '15551230000',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Asha',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'asha@upi',
      fundingMethod: 'bank_transfer',
    });
    expect(t.amountSource).toBe(100);
    expect(t.sourceCurrency).toBe('USD');
    expect(t.amountSource).toBe(t.amountUsd); // USD: source == USD-equiv
    expect(t.feeSource).toBe(t.feeUsd);
    expect(t.totalChargeSource).toBe(t.totalChargeUsd); // USD: source == USD-equiv
    expect(t.partnerId).toBe('default');
  });
});

describe('createTransfer P5: corridor-aware compliance', () => {
  it('P5 regression: default/USD path produces today\'s compliance result', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    await partnerStore.ensureDefaultPartner(); // countries: ['US'], no corridorCompliance
    const t = await createTransfer(store, partnerStore, {
      phone: '15551230000',
      amountSource: 1500, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    });
    expect(t.complianceStatus).toBe('flagged');              // >= 1000 today
    expect(t.complianceReasons).toContain('Large transfer amount.');
  });

  it('P5: a corridor override raises the threshold so a flagged-today amount clears', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    await partnerStore.savePartner({
      id: 'gb-co', name: 'GB Co', countries: ['US', 'GB'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      corridorCompliance: { GB: { largeAmountUsd: 5000 } },
    });
    // Override fetch to return GBP rates (USD + INR) for this test
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.27, INR: 108 } }) }),
    );
    const t = await createTransfer(store, partnerStore, {
      phone: '15551239999',
      amountSource: 1200, sourceCurrency: 'GBP', partnerId: 'gb-co',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    });
    // 1200 GBP → USD-equivalent (~1524) is below the 5000 override → not flagged for amount.
    expect(t.complianceReasons).not.toContain('Large transfer amount.');
  });
});
