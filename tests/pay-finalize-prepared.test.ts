import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeDraftPayment } from '@/lib/pay-finalize';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

// Stage C2 security review: a draft an AI app prepared (Draft.preparedBy) pays ONLY the saved
// recipient's stored account, and a cancel that lands while the payment runs stops the mint.

const PHONE = '15551234567';
const PREPARED_BY = { clientId: 'agc_test', appName: 'Test app' };

async function buildStores() {
  const redis = fakeRedis();
  const db = await freshDb();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const draftStore = createDraftStore(redis);
  const partnerStore = createPartnerStore(db);
  const monthlyVolumeStore = createMonthlyVolumeStore(store);
  const dailyVolumeStore = createDailyVolumeStore(store);
  return { store, customerStore, draftStore, partnerStore, monthlyVolumeStore, dailyVolumeStore, db };
}

async function makeDraft(stores: Awaited<ReturnType<typeof buildStores>>, preparedBy?: typeof PREPARED_BY) {
  const { customer } = await stores.customerStore.upsertOnFirstInbound('default', PHONE);
  await stores.customerStore.saveCustomer({ ...customer, kycStatus: 'verified', fullName: 'Alex Rivera' });
  return stores.draftStore.createDraft({
    senderPhone: PHONE,
    partnerId: 'default',
    recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'mom@upi' },
    amountUsd: 200,
    amountSource: 200,
    sourceCurrency: 'USD',
    fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 200 * 85 },
    ...(preparedBy ? { preparedBy } : {}),
  });
}

const OTHER_ACCOUNT = { payoutMethod: 'bank' as const, payoutDestination: '021000021 12345678901' };

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
});

describe('finalizeDraftPayment — app-prepared drafts', { retry: 0 }, () => {
  it('an app-prepared draft pays the STORED account; bank details in the body never replace it', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, PREPARED_BY);

    const result = await finalizeDraftPayment(stores, draftId, OTHER_ACCOUNT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    const saved = await stores.store.getTransferDecrypted(result.transferId);
    expect(saved?.payoutDestination).toBe('mom@upi');
    expect(saved?.payoutMethod).toBe('upi');
  });

  it('a customer-made draft still takes the body bank details (the page\'s "Edit bank details")', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores);

    const result = await finalizeDraftPayment(stores, draftId, OTHER_ACCOUNT);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect((await stores.store.getTransferDecrypted(result.transferId))?.payoutDestination).toBe('021000021 12345678901');
  });

  it('a cancel that consumes an app-prepared draft after the first read stops the mint', async () => {
    const stores = await buildStores();
    const draftId = await makeDraft(stores, PREPARED_BY);
    const real = stores.draftStore;
    let reads = 0;
    const racing = {
      ...real,
      getDraft: async (id: string) => {
        const d = await real.getDraft(id);
        reads += 1;
        if (reads === 1) await real.consumeDraft(id); // cancel_prepared_transfer lands here
        return d;
      },
    };

    const result = await finalizeDraftPayment({ ...stores, draftStore: racing }, draftId);

    expect(result).toEqual({ ok: false, error: 'expired_or_used' });
    expect(await stores.store.getTransferCount('default', PHONE)).toBe(0);
  });
});
