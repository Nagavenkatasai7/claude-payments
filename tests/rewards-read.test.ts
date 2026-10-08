import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadMyRewards } from '@/lib/rewards/read';
import { createRewardRepo } from '@/db/repos/reward-repo';
import { DEFAULT_CATALOG } from '@/lib/rewards/settings';
import { easternMonth } from '@/lib/dates';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';

// B3 rewards v1: the portal "My rewards" card's read. Shown only while
// rewards are active for the sender (demo mode AND the switch); tenant and
// sender scoped; never throws (a failure hides the card).

const PHONE = '15558880001';
const usd = (n: number) => `$${n.toFixed(2)}`;
const on = { isFlagOn: async () => true };
const off = { isFlagOn: async () => false };

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.DEMO_PHONES;
  process.env.DEMO_PHONES = '*';
});
afterEach(() => {
  if (saved === undefined) delete process.env.DEMO_PHONES;
  else process.env.DEMO_PHONES = saved;
});

describe('loadMyRewards', () => {
  it('switch off or not a demo phone ⇒ null (no card)', async () => {
    const db = await freshDb();
    expect(await loadMyRewards(db, off, 'default', PHONE, new Date(), usd)).toBeNull();
    process.env.DEMO_PHONES = '15550000000';
    expect(await loadMyRewards(db, on, 'default', PHONE, new Date(), usd)).toBeNull();
  });

  it('the offers that are on and the customer’s own kept rewards, never another tenant’s', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme');
    const repo = createRewardRepo(db);
    await repo.upsertCatalog({ ...DEFAULT_CATALOG.nth_transfer, available: true }, 'admin');
    await repo.upsertPartnerSetting('default', { kind: 'nth_transfer', enabled: true, nth: 5 }, 'admin');
    const mine = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid' });
    const theirs = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 100, status: 'paid' });
    for (const [id, partnerId] of [[mine, 'default'], [theirs, 'acme']] as const) {
      await repo.insertRedemption({
        transferId: id, partnerId, phone: PHONE, month: easternMonth(Date.now()),
        reward: { kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } }, giveBackUsd: 0.8, giveBackWithheld: false,
      });
    }
    expect(await loadMyRewards(db, on, 'default', PHONE, new Date(), usd)).toEqual({
      offers: ['Every 5th transfer you send in a month has no fee (up to $2.99 off).'],
      kept: [{ transferId: mine, text: 'Reward: 5th transfer this month (saved $1.99).' }],
    });
    // acme turned nothing on: its customer sees no offers, only its own reward.
    expect(await loadMyRewards(db, on, 'acme', PHONE, new Date(), usd)).toEqual({
      offers: [],
      kept: [{ transferId: theirs, text: 'Reward: 5th transfer this month (saved $1.99).' }],
    });
  });

  it('a read failure ⇒ null (the card is hidden, the page still renders)', async () => {
    const broken = { select: () => { throw new Error('db down'); } } as unknown as Parameters<typeof loadMyRewards>[0];
    expect(await loadMyRewards(broken, on, 'default', PHONE, new Date(), usd)).toBeNull();
  });
});
