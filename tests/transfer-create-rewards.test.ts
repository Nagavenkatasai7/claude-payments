import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransfer, RewardEndedError, REWARD_ENDED_MESSAGE } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { invalidateFlagCache } from '@/lib/flags';
import { DEFAULT_CATALOG } from '@/lib/rewards/settings';
import { buildRefundMessage } from '@/lib/payment';
import { toPartnerRefundRow } from '@/lib/partner-refunds';
import { resetRateCacheForTests } from '@/lib/rate';
import { easternMonth } from '@/lib/dates';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner, seedSender } from './helpers-db';
import type { Db } from '@/db/client';
import type { QuotedReward } from '@/lib/rewards/types';

// B3 rewards v1: the reward is re-checked UNDER the sender lock, the partner
// budget under its own lock inside it, and the redemption is saved in the
// same transaction as the mint. Relative dates only.

const NTH: QuotedReward = { kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } };
const FREE_QUOTE = {
  amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
  amountInr: 17_000, amountSource: 200, feeSource: 0, totalChargeSource: 200,
};

const base = {
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

let savedDemo: string | undefined;
beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }));
  savedDemo = process.env.DEMO_PHONES;
  process.env.DEMO_PHONES = '*';
});
afterEach(() => {
  if (savedDemo === undefined) delete process.env.DEMO_PHONES;
  else process.env.DEMO_PHONES = savedDemo;
  vi.restoreAllMocks();
});

async function setup(opts: { budget?: number; switchOn?: boolean } = {}) {
  const redis = fakeRedis();
  const db = await freshDb();
  const rewards = createRewardRepo(db);
  await rewards.upsertCatalog({ ...DEFAULT_CATALOG.nth_transfer, available: true }, 'admin');
  await rewards.upsertPartnerSetting('default', { kind: 'nth_transfer', enabled: true, nth: 5 }, 'admin');
  await rewards.upsertTerms('default', { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: opts.budget ?? 100 }, 'admin');
  await setSwitch(db, opts.switchOn ?? true);
  const store = createStore(redis, db);
  return { db, store, rewards, partnerStore: createPartnerStore(db), mvs: createMonthlyVolumeStore(store) };
}

async function setSwitch(db: Db, on: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'rewards.enabled', scopeType: 'global', scopeId: '', enabled: on, reason: 'rewards test', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

/** A T1 sender with `n` transfers delivered earlier today (this ET month). */
async function delivered(db: Db, phone: string, n: number, partnerId = 'default') {
  await seedSender(db, { partnerId, phone, firstSeenDaysAgo: 10 });
  for (let i = 0; i < n; i++) await seedLedgerSpend(db, { partnerId, phone, amountUsd: 20, status: 'delivered' });
  await db.execute(sql`UPDATE transfers SET delivered_at = now() WHERE phone = ${phone} AND status = 'delivered'`);
}

async function redemptionCount(db: Db): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM reward_redemptions`);
  return Number((r as unknown as { rows: Array<{ n: number }> }).rows[0].n);
}

describe('createTransfer with a reward (B3)', () => {
  it('the 5th transfer mints at the approved $0 fee with ONE redemption row in the same transaction', async () => {
    const s = await setup();
    const phone = '15559990001';
    await delivered(s.db, phone, 4);
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, id: 'tr_rw_1', quote: FREE_QUOTE, reward: NTH });
    expect([t.feeUsd, t.totalChargeUsd, t.amountInr, t.fxRate]).toEqual([0, 200, 17_000, 85]);
    expect(await s.rewards.getRedemption('default', t.id)).toMatchObject({
      kind: 'nth_transfer', discountUsd: 1.99, giveBackUsd: 0.8, giveBackWithheld: false, detail: { nth: 5 },
    });
    // a claim-first replay of the same id returns the row and adds no second reward
    const again = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, id: 'tr_rw_1', quote: FREE_QUOTE, reward: NTH });
    expect(again.id).toBe(t.id);
    expect(await redemptionCount(s.db)).toBe(1);
  });

  it('two parallel 5th-free transfers ⇒ one reward; the other gets "offer ended" and nothing is written', async () => {
    const s = await setup();
    const phone = '15559990002';
    await delivered(s.db, phone, 4);
    const results = await Promise.allSettled([
      createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH }),
      createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(rejected.reason).toBeInstanceOf(RewardEndedError);
    expect(REWARD_ENDED_MESSAGE).toBe('This offer has ended. Ask for a new quote.');
    expect(await redemptionCount(s.db)).toBe(1);
    expect(await s.store.getTransferCount('default', phone)).toBe(5); // 4 seeded + 1 minted
  });

  it('two senders use up the partner budget: the second is refused under the budget lock', async () => {
    const s = await setup({ budget: 0.8 }); // exactly one 40% give-back of $1.99
    await delivered(s.db, '15559990003', 4);
    await delivered(s.db, '15559990004', 4);
    const results = await Promise.allSettled([
      createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone: '15559990003', quote: FREE_QUOTE, reward: NTH }),
      createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone: '15559990004', quote: FREE_QUOTE, reward: NTH }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof RewardEndedError)).toHaveLength(1);
    expect(await s.rewards.budgetUsed('default', easternMonth(Date.now()))).toBe(0.8);
  });

  it('a $0 budget gives no SmartRemit-funded reward', async () => {
    const s = await setup({ budget: 0 });
    const phone = '15559990005';
    await delivered(s.db, phone, 4);
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH }))
      .rejects.toBeInstanceOf(RewardEndedError);
    expect(await redemptionCount(s.db)).toBe(0);
  });

  it('a transfer compliance flags keeps the price; the give-back is withheld and the budget untouched', async () => {
    const s = await setup({ budget: 0.8 });
    const phone = '15559990006';
    await delivered(s.db, phone, 4);
    const big = { amountUsd: 1500, feeUsd: 0, totalChargeUsd: 1500, fxRate: 85, amountInr: 127_500, amountSource: 1500, feeSource: 0, totalChargeSource: 1500 };
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, amountSource: 1500, quote: big, reward: NTH });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.feeUsd).toBe(0);
    const r = await s.rewards.getRedemption('default', t.id);
    expect(r).toMatchObject({ discountUsd: 1.99, giveBackUsd: 0, giveBackWithheld: true });
    expect(await s.rewards.budgetUsed('default', r!.month)).toBe(0);
  });

  it('the refund is the discounted total the customer paid', async () => {
    const s = await setup();
    const phone = '15559990007';
    await delivered(s.db, phone, 4);
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH });
    expect(toPartnerRefundRow(t, 'admin').amount).toBe(200);
    expect(buildRefundMessage(t)).toContain('$200.00');
    expect(buildRefundMessage(t)).not.toContain('201.99');
  });

  it('a cancelled (or expired) transfer releases the reward: the 5th can be rewarded again', async () => {
    const s = await setup();
    const phone = '15559990008';
    await delivered(s.db, phone, 4);
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH });
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH }))
      .rejects.toBeInstanceOf(RewardEndedError);
    expect(await createTransferRepo(s.db).cancelIfCancellable(t.id, 'default')).not.toBeNull(); // the expiry sweep's cancel
    const again = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH });
    expect(again.feeUsd).toBe(0);
  });

  it('a refunded transfer releases the reward too', async () => {
    const s = await setup();
    const phone = '15559990009';
    await delivered(s.db, phone, 4);
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH });
    await s.db.execute(sql`UPDATE transfers SET refund_status = 'completed' WHERE id = ${t.id}`);
    const again = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH });
    expect(await s.rewards.getRedemption('default', again.id)).not.toBeNull();
  });

  it('switch off before the mint ⇒ "offer ended" with nothing written (the draft is the caller’s to keep)', async () => {
    const s = await setup({ switchOn: false });
    const phone = '15559990010';
    await delivered(s.db, phone, 4);
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, id: 'tr_rw_off', quote: FREE_QUOTE, reward: NTH }))
      .rejects.toBeInstanceOf(RewardEndedError);
    expect(await s.store.getTransfer('tr_rw_off')).toBeNull();
  });

  it('the partner turned the reward off before the mint ⇒ "offer ended"', async () => {
    const s = await setup();
    const phone = '15559990011';
    await delivered(s.db, phone, 4);
    await s.rewards.upsertPartnerSetting('default', { kind: 'nth_transfer', enabled: false, nth: 5 }, 'admin');
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH }))
      .rejects.toBeInstanceOf(RewardEndedError);
  });

  it('the admin lowered the catalog maximum discount after the quote ⇒ "offer ended" (no stale discount or give-back)', async () => {
    const s = await setup();
    const phone = '15559990012';
    await delivered(s.db, phone, 4);
    await s.rewards.upsertCatalog({ ...DEFAULT_CATALOG.nth_transfer, available: true, maxDiscountUsd: 0.5 }, 'admin');
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, id: 'tr_rw_cut', quote: FREE_QUOTE, reward: NTH }))
      .rejects.toBeInstanceOf(RewardEndedError);
    expect(await s.store.getTransfer('tr_rw_cut')).toBeNull();
    expect(await redemptionCount(s.db)).toBe(0);
  });

  it('a demo-mode list without this phone ⇒ "offer ended"', async () => {
    const s = await setup();
    const phone = '15559990012';
    await delivered(s.db, phone, 4);
    process.env.DEMO_PHONES = '15550000000';
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH }))
      .rejects.toBeInstanceOf(RewardEndedError);
  });

  it('sandbox and B2B never take a SmartRemit-funded reward', async () => {
    const s = await setup();
    const phone = '15559990013';
    await delivered(s.db, phone, 4);
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: NTH, environment: 'test' }))
      .rejects.toBeInstanceOf(RewardEndedError);
    expect(await redemptionCount(s.db)).toBe(0);
  });

  it('a reward without an approved quote is ignored: the re-quote prices the normal fee', async () => {
    const s = await setup();
    const phone = '15559990014';
    await delivered(s.db, phone, 4);
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, reward: NTH });
    expect(t.feeUsd).toBe(1.99);
    expect(await redemptionCount(s.db)).toBe(0);
  });

  it('partner A’s rewards and budget never apply to partner B', async () => {
    const s = await setup();
    await seedPartner(s.db, 'acme');
    const phone = '15559990015';
    await delivered(s.db, phone, 4, 'acme');
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, partnerId: 'acme', phone, quote: FREE_QUOTE, reward: NTH }))
      .rejects.toBeInstanceOf(RewardEndedError); // acme turned nothing on and has a $0 budget
  });
});

describe('first transfer free with rewards (B3)', () => {
  const FIRST: QuotedReward = { kind: 'first_transfer', discountUsd: 1.99, detail: {} };

  it('switch on: the free first transfer is recorded (no give-back, no budget)', async () => {
    const s = await setup({ budget: 0 });
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone: '15559990020', quote: FREE_QUOTE, reward: FIRST });
    expect(t.feeUsd).toBe(0);
    expect(await s.rewards.getRedemption('default', t.id)).toMatchObject({ kind: 'first_transfer', discountUsd: 1.99, giveBackUsd: 0 });
  });

  it('switch off: works exactly as today (free, no row)', async () => {
    const s = await setup({ switchOn: false });
    const t = await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone: '15559990021', quote: FREE_QUOTE, reward: FIRST });
    expect(t.feeUsd).toBe(0);
    expect(await redemptionCount(s.db)).toBe(0);
  });

  it('an approved free first transfer the sender already used is still stale_quote (A5)', async () => {
    const s = await setup();
    const phone = '15559990022';
    await createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone });
    await expect(createTransfer(s.store, s.partnerStore, s.mvs, { ...base, phone, quote: FREE_QUOTE, reward: FIRST }))
      .rejects.toMatchObject({ name: 'RateUnavailableError', reason: 'stale_quote' });
  });
});
