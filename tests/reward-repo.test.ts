import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { DEFAULT_CATALOG, DEFAULT_TERMS } from '@/lib/rewards/settings';
import { easternMonth, easternMonthStart } from '@/lib/dates';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// B3 rewards v1: the repo (real Postgres via PGlite). Tenant isolation, the
// release rule (cancelled / blocked / refunded transfers give the reward back),
// the one-row-per-transfer keys and the platform fee ledger.

const PHONE = '15557770001';
const month = () => easternMonth(Date.now());

async function redeem(db: Db, partnerId: string, transferId: string, kind: 'nth_transfer' | 'festival' | 'first_transfer' = 'nth_transfer', giveBackUsd = 0.8) {
  await createRewardRepo(db).insertRedemption({
    transferId, partnerId, phone: PHONE, month: month(),
    reward: { kind, discountUsd: 1.99, detail: kind === 'nth_transfer' ? { nth: 5 } : {} },
    giveBackUsd, giveBackWithheld: false,
  });
}

describe('reward-repo — defaults and settings', () => {
  it('no rows ⇒ the code defaults: nothing available, $0.60 fee, 40%, $0 budget', async () => {
    const db = await freshDb();
    const repo = createRewardRepo(db);
    expect(await repo.getCatalog()).toEqual(DEFAULT_CATALOG);
    expect(await repo.getTerms('default')).toEqual(DEFAULT_TERMS);
    expect(await repo.getPartnerSettings('default')).toEqual({ nth_transfer: undefined, festival: undefined });
  });

  it('catalog and terms round-trip', async () => {
    const db = await freshDb();
    const repo = createRewardRepo(db);
    await repo.upsertCatalog({ ...DEFAULT_CATALOG.festival, available: true, festivalNames: ['Diwali'] }, 'admin');
    expect((await repo.getCatalog()).festival).toMatchObject({ available: true, festivalNames: ['Diwali'] });
    await repo.upsertTerms('default', { platformFeeUsd: 0.5, giveBackPct: 30, monthlyBudgetUsd: 250 }, 'admin');
    expect(await repo.getTerms('default')).toEqual({ platformFeeUsd: 0.5, giveBackPct: 30, monthlyBudgetUsd: 250 });
  });

  it('partner A cannot read or change partner B: settings and redemptions are tenant-scoped', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme');
    await seedPartner(db, 'beta');
    const repo = createRewardRepo(db);
    await repo.upsertPartnerSetting('acme', { kind: 'nth_transfer', enabled: true, nth: 5 }, 'acme-admin');
    expect((await repo.getPartnerSettings('acme')).nth_transfer).toMatchObject({ enabled: true, nth: 5 });
    expect((await repo.getPartnerSettings('beta')).nth_transfer).toBeUndefined();
    await repo.upsertPartnerSetting('beta', { kind: 'nth_transfer', enabled: true, nth: 3 }, 'beta-admin');
    expect((await repo.getPartnerSettings('acme')).nth_transfer?.nth).toBe(5);

    const tid = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 100 });
    await redeem(db, 'acme', tid);
    expect(await repo.getRedemption('acme', tid)).toMatchObject({ kind: 'nth_transfer', discountUsd: 1.99 });
    expect(await repo.getRedemption('beta', tid)).toBeNull();
    expect((await repo.listByTransferIds('beta', [tid])).size).toBe(0);
    expect(await repo.listCustomerRewards('beta', PHONE)).toEqual([]);
  });
});

describe('reward-repo — one reward per transfer, release, usage', () => {
  it('a second redemption for the same transfer is refused by the database key', async () => {
    const db = await freshDb();
    const tid = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100 });
    await redeem(db, 'default', tid);
    await expect(redeem(db, 'default', tid, 'festival')).rejects.toThrow();
  });

  it('usage counts delivered transfers this month and held rewards; cancel, block and refund release them', async () => {
    const db = await freshDb();
    const repo = createRewardRepo(db);
    for (let i = 0; i < 3; i++) await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered' });
    await db.execute(sql`UPDATE transfers SET delivered_at = now()`);
    const a = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50 });
    const b = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50 });
    await redeem(db, 'default', a, 'nth_transfer');
    await redeem(db, 'default', b, 'festival');
    const start = easternMonthStart(new Date());
    expect(await repo.senderUsage('default', PHONE, month(), start)).toEqual({
      deliveredThisMonth: 3, activeThisMonth: { nth_transfer: 1, festival: 1 },
    });
    expect(await repo.budgetUsed('default', month())).toBe(1.6);
    await db.execute(sql`UPDATE transfers SET status = 'cancelled' WHERE id = ${a}`);
    await db.execute(sql`UPDATE transfers SET refund_status = 'completed' WHERE id = ${b}`);
    expect(await repo.senderUsage('default', PHONE, month(), start)).toEqual({
      deliveredThisMonth: 3, activeThisMonth: { nth_transfer: 0, festival: 0 },
    });
    expect(await repo.budgetUsed('default', month())).toBe(0);
    const mine = await repo.listCustomerRewards('default', PHONE);
    expect(mine.map((r) => r.released)).toEqual([true, true]);
  });

  it('a refunded delivered transfer no longer counts toward the Nth', async () => {
    const db = await freshDb();
    const repo = createRewardRepo(db);
    const d = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered' });
    await db.execute(sql`UPDATE transfers SET delivered_at = now(), refund_status = 'completed' WHERE id = ${d}`);
    expect((await repo.senderUsage('default', PHONE, month(), easternMonthStart(new Date()))).deliveredThisMonth).toBe(0);
  });

  it('withholdGiveBackIfFlagged: only a flagged transfer, once', async () => {
    const db = await freshDb();
    const repo = createRewardRepo(db);
    const clean = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50 });
    const flagged = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50 });
    await db.execute(sql`UPDATE transfers SET compliance_status = 'flagged' WHERE id = ${flagged}`);
    await redeem(db, 'default', clean);
    await redeem(db, 'default', flagged);
    expect(await repo.withholdGiveBackIfFlagged(clean)).toBe(false);
    expect(await repo.withholdGiveBackIfFlagged(flagged)).toBe(true);
    expect(await repo.withholdGiveBackIfFlagged(flagged)).toBe(false);
    expect(await repo.getRedemption('default', flagged)).toMatchObject({ giveBackWithheld: true, giveBackUsd: 0, discountUsd: 1.99 });
    expect(await repo.budgetUsed('default', month())).toBe(0.8);
  });
});

describe('reward-repo — platform fee ledger', () => {
  it('one row per transfer at the partner fee (default $0.60); a replay adds nothing', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme');
    const repo = createRewardRepo(db);
    await repo.upsertTerms('acme', { platformFeeUsd: 0.45, giveBackPct: 40, monthlyBudgetUsd: 0 }, 'admin');
    const a = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered' });
    const b = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 50, status: 'delivered' });
    expect(await repo.recordPlatformFee({ id: a, partnerId: 'default' }, month())).toBe(true);
    expect(await repo.recordPlatformFee({ id: a, partnerId: 'default' }, month())).toBe(false);
    expect(await repo.recordPlatformFee({ id: b, partnerId: 'acme' }, month())).toBe(true);
    const facts = await repo.statementFacts(month());
    expect(facts).toEqual([
      { partnerId: 'acme', deliveredCount: 1, feeOwedUsd: 0.45, rewards: [] },
      { partnerId: 'default', deliveredCount: 1, feeOwedUsd: 0.6, rewards: [] },
    ]);
    expect(await repo.statementFacts(month(), 'acme')).toHaveLength(1);
  });

  it('listFeeGaps: live delivered transfers with no fee row only', async () => {
    const db = await freshDb();
    const repo = createRewardRepo(db);
    const done = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered' });
    const gap = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered' });
    const test = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'delivered' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50, status: 'paid' });
    await db.execute(sql`UPDATE transfers SET delivered_at = now() WHERE status = 'delivered'`);
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${test}`);
    await repo.recordPlatformFee({ id: done, partnerId: 'default' }, month());
    const gaps = await repo.listFeeGaps(new Date(Date.now() - 86_400_000), 50);
    expect(gaps.map((g) => g.id)).toEqual([gap]);
  });
});
