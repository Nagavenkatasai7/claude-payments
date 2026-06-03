import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransfer, recordBlockedAttempt } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
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
  senderKycStatus: 'verified' as const,
};

describe('createTransfer', () => {
  it('creates a cleared transfer in awaiting_payment', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.status).toBe('awaiting_payment');
    expect(t.complianceStatus).toBe('cleared');
    expect(await store.getTransfer(t.id)).not.toBeNull();
  });

  it('blocks a watchlisted recipient and sets status blocked', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, recipientName: 'John Doe' });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.status).toBe('blocked');
  });

  it('flags a large amount but stays awaiting_payment', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    const t = await createTransfer(store, partnerStore, mvs, { ...base, amountSource: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.status).toBe('awaiting_payment');
  });

  it('increments the all-time and today counters', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await createTransfer(store, partnerStore, mvs, base);
    expect(await store.getTransferCount(base.phone)).toBe(1);
    expect(await store.getTodayTransferCount(base.phone)).toBe(1);
  });
});

describe('createTransfer P1: country + currency fields', () => {
  it('populates all 4 new fields with defaults', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551112222',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified' as const,
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
    const mvs = createMonthlyVolumeStore(redis);
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551112222',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified' as const,
    });
    expect(t.partnerId).toBe('default');
  });
});

describe('createTransfer P4: source-currency fields', () => {
  it('P4: populates source-currency fields (USD scaffold) from the quote', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230000',
      amountSource: 100,
      sourceCurrency: 'USD',
      partnerId: 'default',
      recipientName: 'Asha',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'asha@upi',
      fundingMethod: 'bank_transfer',
      senderKycStatus: 'verified' as const,
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
    const mvs = createMonthlyVolumeStore(redis);
    await partnerStore.ensureDefaultPartner(); // countries: ['US'], no corridorCompliance
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230000',
      amountSource: 1500, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('flagged');              // >= 1000 today
    expect(t.complianceReasons).toContain('Large transfer amount.');
  });

  it('P5: a corridor override raises the threshold so a flagged-today amount clears', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
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
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551239999',
      amountSource: 1200, sourceCurrency: 'GBP', partnerId: 'gb-co',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    // 1200 GBP → USD-equivalent (~1524) is below the 5000 override → not flagged for amount.
    expect(t.complianceReasons).not.toContain('Large transfer amount.');
  });
});

describe('createTransfer KYC: EDD merge + Travel-Rule + monthly accrual', () => {
  it('KYC dormant: a sub-$3k send produces today\'s compliance result exactly (regression)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await partnerStore.ensureDefaultPartner();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230000', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('cleared');
    expect(t.complianceReasons).toEqual([]);
    expect(t.eddRequired).toBeFalsy();
  });

  it('KYC: a $3k-cumulative send with missing EDD fields → flagged + edd_required (NOT blocked)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15551230001', 250_000);  // $2,500 already this month
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230001', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.complianceReasons).toContain('edd_required');
    expect(t.eddRequired).toBe(true);
    expect(t.status).not.toBe('blocked'); // EDD never hard-blocks; customer not suspended
  });

  it('KYC: $3k send WITH EDD fields present → no EDD flag', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15551230002', 250_000);
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230002', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
      sourceOfFunds: 'employment', occupation: 'salaried',
    });
    expect(t.complianceReasons).not.toContain('edd_required');
  });

  it('KYC precedence: a watchlist hit still BLOCKS even when EDD would flag', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await partnerStore.ensureDefaultPartner();
    await mvs.addCents('15551230003', 250_000);
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230003', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'John Doe',  // on WATCHLIST
      recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).not.toContain('edd_required');
  });

  it('KYC: monthlyVolumeStore.addCents called with USD-equivalent cents after save', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await partnerStore.ensureDefaultPartner();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230004', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
    });
    expect(await mvs.getMonthCents('15551230004')).toBe(Math.round(t.amountUsd * 100));
  });

  it('KYC: Travel-Rule fields are written onto the Transfer when supplied', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await partnerStore.ensureDefaultPartner();
    const t = await createTransfer(store, partnerStore, mvs, {
      phone: '15551230005', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer', senderKycStatus: 'verified' as const,
      recipientLegalName: 'Mother Legal Name', relationship: 'parent', purpose: 'family_support',
    });
    expect(t.recipientLegalName).toBe('Mother Legal Name');
    expect(t.relationship).toBe('parent');
    expect(t.purpose).toBe('family_support');
  });
});

describe('createTransfer any-to-any corridors', () => {
  it('a transfer with destinationCountry AE has destinationCurrency AED and amountInr in AED', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    // Mock: USD rates return {INR:85}; AED rates return {INR:23.1, USD:0.27}
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('from=AED')) {
        return { ok: true, json: async () => ({ rates: { INR: 23.1, USD: 0.27 } }) };
      }
      return { ok: true, json: async () => ({ rates: { INR: 85 } }) };
    }));
    const t = await createTransfer(store, partnerStore, mvs, {
      ...base,
      destinationCountry: 'AE',
      destinationCurrency: 'AED',
    });
    expect(t.destinationCountry).toBe('AE');
    expect(t.destinationCurrency).toBe('AED');
    // Cross-rate USD→AED: 1 / 0.27 ≈ 3.703; 200 USD → ~741 AED
    expect(t.amountInr).toBeGreaterThan(500);   // AED amount, much less than 200 * 85 = 17000 INR
    expect(t.amountInr).toBeLessThan(5000);      // but reasonable for ~740 AED
    expect(t.amountUsd).toBeCloseTo(200, 0);     // USD-equiv unchanged
  });

  it('a transfer with NO destinationCountry defaults to IN/INR (back-compat invariant)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    // Standard mock: USD→INR=85
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ rates: { INR: 85 } }),
    })));
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.destinationCountry).toBe('IN');
    expect(t.destinationCurrency).toBe('INR');
    expect(t.amountInr).toBe(Math.round(200 * 85)); // 17000 INR — identical to old behavior
  });

  it('existing India tests are unchanged — US→IN transfer complianceStatus cleared at $200', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const partnerStore = createPartnerStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    const t = await createTransfer(store, partnerStore, mvs, base);
    expect(t.complianceStatus).toBe('cleared');
    expect(t.destinationCurrency).toBe('INR');
  });
});

describe('recordBlockedAttempt', () => {
  const blockedInput = {
    phone: '15551234567',
    recipientName: 'John Doe',
    recipientPhone: '919133001840',
    payoutMethod: 'bank' as const,
    payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'bank_transfer' as const,
    amountUsd: 100,
    amountSource: 100,
    sourceCurrency: 'USD' as const,
    feeUsd: 1.99,
    feeSource: 1.99,
    fxRate: 85,
    amountInr: 8500,
    totalChargeUsd: 101.99,
    totalChargeSource: 101.99,
    destinationCountry: 'IN' as const,
    destinationCurrency: 'INR' as const,
    partnerId: 'default',
    reasons: ['Recipient is on the compliance watchlist.'],
  };

  it('persists an auditable blocked row (status + complianceStatus blocked)', async () => {
    const store = createStore(fakeRedis());
    const t = await recordBlockedAttempt(store, blockedInput);
    expect(t.status).toBe('blocked');
    expect(t.complianceStatus).toBe('blocked');
    expect(t.complianceReasons).toEqual(['Recipient is on the compliance watchlist.']);
    const fetched = await store.getTransfer(t.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe('blocked');
    expect(fetched?.recipientName).toBe('John Doe');
    expect(fetched?.destinationCurrency).toBe('INR');
  });

  it('does NOT advance velocity or volume counters (a blocked attempt is never charged)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const mvs = createMonthlyVolumeStore(redis);
    await recordBlockedAttempt(store, blockedInput);
    expect(await store.getTransferCount(blockedInput.phone)).toBe(0);
    expect(await store.getTodayTransferCount(blockedInput.phone)).toBe(0);
    expect(await mvs.getMonthCents(blockedInput.phone)).toBe(0);
  });

  it('does NOT add the watchlisted recipient to the saved list', async () => {
    const store = createStore(fakeRedis());
    await recordBlockedAttempt(store, blockedInput);
    const recipients = await store.listRecipients(blockedInput.phone, 25);
    expect(recipients).toHaveLength(0);
  });
});
