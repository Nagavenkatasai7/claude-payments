import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { deliverTransfer } from '@/lib/delivery-receipt';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { deliveryMonth, sweepPlatformFeeGaps } from '@/lib/rewards/fee-ledger';
import { computeStatement } from '@/lib/rewards/statement';
import { easternMonth } from '@/lib/dates';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// B3 rewards v1: every LIVE delivered transfer gets ONE platform fee row,
// written in the delivery transaction; a ledger failure never blocks the
// delivery; the sweep fills the gap; a flagged transfer's give-back is withheld.

const PHONE = '15554440001';

async function feeRows(db: Db): Promise<Array<{ transfer_id: string; fee_usd: string; month: string }>> {
  const r = await db.execute(sql`SELECT transfer_id, fee_usd, month FROM platform_fee_ledger ORDER BY transfer_id`);
  return (r as unknown as { rows: Array<{ transfer_id: string; fee_usd: string; month: string }> }).rows;
}

describe('platform fee ledger on delivery (B3)', () => {
  it('a live delivery writes one row at the partner fee; a replayed delivery adds none', async () => {
    const db = await freshDb();
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    expect(await deliverTransfer(db, id)).not.toBeNull();
    expect(await deliverTransfer(db, id)).toBeNull(); // no transition the second time
    expect(await feeRows(db)).toEqual([{ transfer_id: id, fee_usd: '0.60', month: easternMonth(Date.now()) }]);
  });

  it('the fee is the partner’s admin-set fee at delivery time', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme');
    await createRewardRepo(db).upsertTerms('acme', { platformFeeUsd: 0.45, giveBackPct: 40, monthlyBudgetUsd: 0 }, 'admin');
    const id = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 100, status: 'paid' });
    await deliverTransfer(db, id);
    expect((await feeRows(db))[0].fee_usd).toBe('0.45');
  });

  it('a sandbox (test) delivery owes no platform fee', async () => {
    const db = await freshDb();
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${id}`);
    expect(await deliverTransfer(db, id)).not.toBeNull();
    expect(await feeRows(db)).toEqual([]);
  });

  it('a ledger failure never blocks the delivery; the sweep fills the gap once', async () => {
    const db = await freshDb();
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    await db.execute(sql`ALTER TABLE platform_fee_ledger RENAME TO platform_fee_ledger_off`);
    try {
      const delivered = await deliverTransfer(db, id);
      expect(delivered?.status).toBe('delivered');
    } finally {
      await db.execute(sql`ALTER TABLE platform_fee_ledger_off RENAME TO platform_fee_ledger`);
    }
    expect(await feeRows(db)).toEqual([]);
    expect(await sweepPlatformFeeGaps(db)).toBe(1);
    expect(await sweepPlatformFeeGaps(db)).toBe(0);
    expect((await feeRows(db)).map((r) => r.transfer_id)).toEqual([id]);
  });

  it('a transfer compliance flagged keeps its reward price; the give-back is withheld at delivery', async () => {
    const db = await freshDb();
    const rewards = createRewardRepo(db);
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    await rewards.insertRedemption({
      transferId: id, partnerId: 'default', phone: PHONE, month: easternMonth(Date.now()),
      reward: { kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } }, giveBackUsd: 0.8, giveBackWithheld: false,
    });
    await db.execute(sql`UPDATE transfers SET compliance_status = 'flagged' WHERE id = ${id}`);
    await deliverTransfer(db, id);
    expect(await rewards.getRedemption('default', id)).toMatchObject({ discountUsd: 1.99, giveBackUsd: 0, giveBackWithheld: true });
  });

  it('deliveryMonth is the ET month of the delivery', () => {
    expect(deliveryMonth({ deliveredAt: '2026-11-01T03:00:00.000Z' })).toBe('2026-10'); // 23:00 ET on Oct 31
    expect(deliveryMonth({ deliveredAt: '2026-11-01T05:00:00.000Z' })).toBe('2026-11');
  });

  it('the statement counts rewards only on delivered transfers, refunds left out', async () => {
    const db = await freshDb();
    const rewards = createRewardRepo(db);
    const month = easternMonth(Date.now());
    const redeem = (id: string) => rewards.insertRedemption({
      transferId: id, partnerId: 'default', phone: PHONE, month,
      reward: { kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } }, giveBackUsd: 0.8, giveBackWithheld: false,
    });
    const delivered = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    const pending = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    const refunded = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    for (const id of [delivered, pending, refunded]) await redeem(id);
    await deliverTransfer(db, delivered);
    await deliverTransfer(db, refunded);
    await db.execute(sql`UPDATE transfers SET refund_status = 'completed' WHERE id = ${refunded}`);
    const [f] = await rewards.statementFacts(month, 'default');
    const s = computeStatement(month, f, { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 100 });
    expect(s).toMatchObject({ deliveredCount: 2, feeOwedUsd: 1.2, rewardsGiven: { count: 1, usd: 1.99 }, giveBackCreditUsd: 0.8, netUsd: 0.4 });
  });
});
