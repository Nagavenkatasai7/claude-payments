import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeTool, getQuoteTyped, prepareSendDraft, buildApproveSummary } from '@/lib/tools';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createDraftStore } from '@/lib/draft-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createPartnerStore } from '@/lib/partner-store';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { DEFAULT_CATALOG } from '@/lib/rewards/settings';
import { finalizeDraftPayment } from '@/lib/pay-finalize';
import { payErrorMessage } from '@/lib/pay-outcome';
import { quote } from '@/lib/fx';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend } from './helpers-db';
import type { Db } from '@/db/client';

// B3 rewards v1 through the bot and portal quote paths: get_quote, the
// approval card + draft, and the pay-page mint (pay-finalize). Phones are fakes.

const PHONE = '15558880001';
let db: Db;
let savedDemo: string | undefined;

beforeEach(async () => {
  resetRateCacheForTests();
  db = await freshDb();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }), text: async () => '' }));
  savedDemo = process.env.DEMO_PHONES;
  process.env.DEMO_PHONES = '*';
});
afterEach(() => {
  if (savedDemo === undefined) delete process.env.DEMO_PHONES;
  else process.env.DEMO_PHONES = savedDemo;
  vi.restoreAllMocks();
});

async function setSwitch(on: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'rewards.enabled', scopeType: 'global', scopeId: '', enabled: on, reason: 'rewards test', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

async function buildCtx() {
  const redis = fakeRedis();
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  const firstSeenAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default',
    optInAt: firstSeenAt, fullName: 'Alex Rivera', createdAt: firstSeenAt, updatedAt: firstSeenAt,
  });
  return {
    phone: PHONE,
    partnerId: 'default',
    store,
    scheduleStore: createScheduleStore(db),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false } as const,
    customerStore,
    dailyVolumeStore: createDailyVolumeStore(store),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    kycProvider: new MockKycProvider(customerStore, 'https://example.com'),
    partnerStore: createPartnerStore(db),
  };
}

/** Rewards set up for the default partner, and `n` transfers delivered this month. */
async function rewardsOn(n: number) {
  const rewards = createRewardRepo(db);
  await rewards.upsertCatalog({ ...DEFAULT_CATALOG.nth_transfer, available: true }, 'admin');
  await rewards.upsertPartnerSetting('default', { kind: 'nth_transfer', enabled: true, nth: 5 }, 'admin');
  await rewards.upsertTerms('default', { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 100 }, 'admin');
  await setSwitch(true);
  for (let i = 0; i < n; i++) await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 20, status: 'delivered' });
  await db.execute(sql`UPDATE transfers SET delivered_at = now() WHERE status = 'delivered'`);
  return rewards;
}

const SEND = { recipientPhone: '919876543210', recipientName: 'Mom', amountSource: 200, fundingMethod: 'bank_transfer' };

describe('get_quote with rewards (B3)', () => {
  it('the 5th transfer is quoted at $0 with the reward line; amount and payout unchanged', async () => {
    await rewardsOn(4);
    const ctx = await buildCtx();
    const r = await executeTool('get_quote', { amount_usd: 200, funding_method: 'bank_transfer' }, ctx);
    expect(r).toMatchObject({ fee_usd: 0, total_charge_usd: 200, amount_usd: 200, amount_inr: 17_000, fx_rate: 85 });
    expect(r.reward_note).toBe('Fee $0.00, your 5th transfer this month is free (you save $1.99).');
  });

  it('switch off ⇒ the normal fee and no reward key (today’s record)', async () => {
    await rewardsOn(4);
    await setSwitch(false);
    const ctx = await buildCtx();
    const r = await executeTool('get_quote', { amount_usd: 200, funding_method: 'bank_transfer' }, ctx);
    expect(r.fee_usd).toBe(1.99);
    expect(r).not.toHaveProperty('reward_note');
  });

  it('the 4th transfer gets no reward', async () => {
    await rewardsOn(3);
    const ctx = await buildCtx();
    const r = await getQuoteTyped(ctx, { amountSource: 200, fundingMethod: 'bank_transfer' });
    expect(r.kind === 'quote' && r.quote.feeUsd).toBe(1.99);
    expect(r.kind === 'quote' && r.reward).toBeUndefined();
  });
});

describe('approval card, draft and pay-page mint with a reward (B3)', () => {
  it('the card says the reward, the draft keeps it, the mint records it at the shown price', async () => {
    const rewards = await rewardsOn(4);
    const ctx = await buildCtx();
    const r = await prepareSendDraft(ctx, SEND);
    if (r.kind !== 'draft') throw new Error(`unexpected ${r.kind}`);
    expect(r.summary).toContain('Fee $0.00, your 5th transfer this month is free (you save $1.99).');
    const draft = await ctx.draftStore.getDraft(r.draftId);
    expect(draft?.reward).toEqual({ kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } });
    expect(draft?.quote.feeUsd).toBe(0);
    const res = await finalizeDraftPayment({ ...ctx, db }, r.draftId, { payoutMethod: 'upi', payoutDestination: 'mom@upi' });
    if (!res.ok) throw new Error(`unexpected ${res.error}`);
    const t = await ctx.store.getTransfer(res.transferId);
    expect([t?.feeUsd, t?.totalChargeUsd, t?.amountInr]).toEqual([0, 200, 17_000]);
    expect(await rewards.getRedemption('default', res.transferId)).toMatchObject({ kind: 'nth_transfer', discountUsd: 1.99 });
  });

  it('the reward ended before payment ⇒ "This offer has ended. Ask for a new quote." and the draft is KEPT', async () => {
    await rewardsOn(4);
    const ctx = await buildCtx();
    const r = await prepareSendDraft(ctx, SEND);
    if (r.kind !== 'draft') throw new Error(`unexpected ${r.kind}`);
    await setSwitch(false);
    const res = await finalizeDraftPayment({ ...ctx, db }, r.draftId, { payoutMethod: 'upi', payoutDestination: 'mom@upi' });
    expect(res).toEqual({ ok: false, error: 'reward_ended' });
    expect(await ctx.draftStore.getDraft(r.draftId)).not.toBeNull();
    expect(payErrorMessage({ reason: 'reward_ended' })).toBe('This offer has ended. Ask for a new quote.');
  });

  it('first transfer: today’s card wording, the reward rides the draft and is recorded', async () => {
    const rewards = await rewardsOn(0);
    const ctx = await buildCtx();
    const r = await prepareSendDraft(ctx, SEND);
    if (r.kind !== 'draft') throw new Error(`unexpected ${r.kind}`);
    expect(r.summary).toContain('first transfer free — you save $1.99');
    const res = await finalizeDraftPayment({ ...ctx, db }, r.draftId, { payoutMethod: 'upi', payoutDestination: 'mom@upi' });
    if (!res.ok) throw new Error(`unexpected ${res.error}`);
    expect(await rewards.getRedemption('default', res.transferId)).toMatchObject({ kind: 'first_transfer', giveBackUsd: 0 });
  });
});

describe('buildApproveSummary reward line (B3)', () => {
  it('no reward ⇒ unchanged; a card fee keeps its % part and says the saving', () => {
    const rates = { toInr: 85, toUsd: 1 };
    const base = quote(200, 'USD', rates, 'credit_card', 4);
    const plain = buildApproveSummary(base, 'Mom', 'upi', 'mom@upi', 'credit_card');
    expect(plain).toContain('Fee $8.99');
    const off = quote(200, 'USD', rates, 'credit_card', 4, 'INR', undefined, undefined, { feeDiscountUsd: 2.99 });
    const s = buildApproveSummary(off, 'Mom', 'upi', 'mom@upi', 'credit_card', 'INR', undefined, undefined, {
      kind: 'nth_transfer', discountUsd: 2.99, detail: { nth: 5 },
    });
    expect(s).toContain('Fee $6.00, a reward for your 5th transfer this month (you save $2.99).');
  });
});
