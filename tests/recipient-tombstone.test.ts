import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { recipients, recipientTombstones, transfers } from '@/db/schema';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { createStore } from '@/lib/store';
import { resolveStoredPayout, type ToolContext } from '@/lib/tools';
import { newTransferId } from '@/lib/id';
import type { Recipient, Schedule } from '@/lib/types';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';

// UI redesign M2-8, Task 8.2 (owner/main 16:00 rule): "delete recipient" WRITES a tombstone and
// KEEPS the recipients row (the FK recipient_tombstones → recipients is ON DELETE no action). Every
// read (the bot's listRecipients / resolveStoredPayout, the web) filters tombstoned recipients.

const SENDER = '14155550101';
const SENDER_2 = '14155550202';
const RP = '919000000000'; // seedLedgerSpend's recipient phone, so a settled transfer to it exists
const OTHER_RP = '919000000009';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
});

const rec = (recipientPhone: string, dest: string, at = '2026-06-01T00:00:00.000Z'): Recipient => ({
  name: 'Test Recipient',
  recipientPhone,
  payoutMethod: 'bank',
  payoutDestination: dest,
  lastUsedAt: at,
});

const toolCtx = (partnerId: string, phone: string): ToolContext =>
  ({ store: createStore(fakeRedis(), db), partnerId, phone }) as unknown as ToolContext;

async function recipientRowCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM recipients`);
  return (r.rows[0] as { n: number }).n;
}

describe('recipient tombstone (repo)', () => {
  it('tombstoneRecipient hides the recipient from listRecipients and KEEPS the recipients row', async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    await repo.upsertRecipient('pa', SENDER, rec(OTHER_RP, '000055556666 HDFC0000002', '2026-06-02T00:00:00.000Z'));
    const before = await recipientRowCount();
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect((await repo.listRecipients('pa', SENDER, 25)).map((r) => r.recipientPhone)).toEqual([OTHER_RP]);
    expect(await recipientRowCount()).toBe(before);
    const kept = await db.select().from(recipients).where(and(eq(recipients.partnerId, 'pa'), eq(recipients.recipientPhone, RP)));
    expect(kept).toHaveLength(1);
  });

  it("a tombstone of A's recipient leaves B's recipient with the SAME phone (other partner, other sender) untouched", async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    await repo.upsertRecipient('pb', SENDER, rec(RP, '000033334444 ICIC0000001'));
    await repo.upsertRecipient('pa', SENDER_2, rec(RP, '000077778888 SBIN0000001'));
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect(await repo.listRecipients('pa', SENDER, 25)).toEqual([]);
    expect((await repo.listRecipients('pb', SENDER, 25)).map((r) => r.payoutDestination)).toEqual(['000033334444 ICIC0000001']);
    expect((await repo.listRecipients('pa', SENDER_2, 25)).map((r) => r.payoutDestination)).toEqual(['000077778888 SBIN0000001']);
    expect(await repo.isTombstoned('pb', SENDER, RP)).toBe(false);
    expect(await repo.isTombstoned('pa', SENDER_2, RP)).toBe(false);
    expect(await repo.isTombstoned('pa', SENDER, RP)).toBe(true);
  });

  it('tombstoneRecipient is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    await repo.tombstoneRecipient('pa', SENDER, RP);
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect(await db.select().from(recipientTombstones)).toHaveLength(1);
  });

  it('isTombstoned matches a formatted phone to the stored key', async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect(await repo.isTombstoned('pa', SENDER, `+${RP}`)).toBe(true);
  });

  it('a later upsert (a new payment with bank details) removes the tombstone (O5)', async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    await repo.tombstoneRecipient('pa', SENDER, RP);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000099990000 HDFC0000003', '2026-06-03T00:00:00.000Z'));
    expect(await repo.isTombstoned('pa', SENDER, RP)).toBe(false);
    expect((await repo.listRecipients('pa', SENDER, 25)).map((r) => r.payoutDestination)).toEqual(['000099990000 HDFC0000003']);
  });

  it('upsert clears only ITS OWN tombstone', async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    await repo.upsertRecipient('pb', SENDER, rec(RP, '000033334444 ICIC0000001'));
    await repo.tombstoneRecipient('pa', SENDER, RP);
    await repo.tombstoneRecipient('pb', SENDER, RP);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    expect(await repo.isTombstoned('pa', SENDER, RP)).toBe(false);
    expect(await repo.isTombstoned('pb', SENDER, RP)).toBe(true);
  });

  it('listAllForSender has no LIMIT, is newest first, tenant + sender scoped and hides tombstoned rows', async () => {
    const repo = createRecipientRepo(db);
    for (let i = 0; i < 30; i++) {
      const at = new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString();
      await repo.upsertRecipient('pa', SENDER, rec(`9190000001${String(i).padStart(2, '0')}`, `0000111100${String(i).padStart(2, '0')}`, at));
    }
    await repo.upsertRecipient('pb', SENDER, rec(RP, '000033334444'));
    await repo.upsertRecipient('pa', SENDER_2, rec(RP, '000077778888'));
    await repo.tombstoneRecipient('pa', SENDER, '919000000105');
    const all = await repo.listAllForSender('pa', SENDER);
    expect(all).toHaveLength(29);
    expect(all[0].recipientPhone).toBe('919000000129');
    expect(all.some((r) => r.recipientPhone === '919000000105' || r.recipientPhone === RP)).toBe(false);
  });

  it('getRecipient returns the live row for its own key only (null when tombstoned or out of scope)', async () => {
    const repo = createRecipientRepo(db);
    await repo.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    expect((await repo.getRecipient('pa', SENDER, RP))?.payoutDestination).toBe('000011112222 HDFC0000001');
    expect(await repo.getRecipient('pb', SENDER, RP)).toBeNull();
    expect(await repo.getRecipient('pa', SENDER_2, RP)).toBeNull();
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect(await repo.getRecipient('pa', SENDER, RP)).toBeNull();
  });

  it('the store wrappers reach the same repo', async () => {
    const store = createStore(fakeRedis(), db);
    await store.upsertRecipient('pa', SENDER, rec(RP, '000011112222 HDFC0000001'));
    await store.tombstoneRecipient('pa', SENDER, RP);
    expect(await store.isTombstoned('pa', SENDER, RP)).toBe(true);
    expect(await store.listRecipients('pa', SENDER, 25)).toEqual([]);
    expect(await store.listAllRecipientsForSender('pa', SENDER)).toEqual([]);
  });
});

describe('resolveStoredPayout honours the tombstone (the X7 regression)', () => {
  async function seedSavedAndSettled(partnerId: 'pa' | 'pb', dest: string) {
    await createRecipientRepo(db).upsertRecipient(partnerId, SENDER, rec(RP, dest));
    await seedLedgerSpend(db, { partnerId, phone: SENDER, amountUsd: 40, status: 'delivered' });
  }

  it('non-tombstoned: the saved book wins (unchanged behaviour)', async () => {
    await seedSavedAndSettled('pa', '000011112222 HDFC0000001');
    expect(await resolveStoredPayout(toolCtx('pa', SENDER), RP, 'IN')).toEqual({ payoutMethod: 'bank', payoutDestination: '000011112222 HDFC0000001' });
  });

  it('tombstoned: null even though a settled transfer to it exists (no ledger fallback)', async () => {
    await seedSavedAndSettled('pa', '000011112222 HDFC0000001');
    await createRecipientRepo(db).tombstoneRecipient('pa', SENDER, RP);
    expect(await resolveStoredPayout(toolCtx('pa', SENDER), RP, 'IN')).toBeNull();
  });

  it('a never-saved recipient still falls back to the settled ledger (unchanged)', async () => {
    await seedLedgerSpend(db, { partnerId: 'pa', phone: SENDER, amountUsd: 40, status: 'delivered' });
    expect(await resolveStoredPayout(toolCtx('pa', SENDER), RP, 'IN')).toEqual({ payoutMethod: 'bank', payoutDestination: '000011112222|HDFC0000001' });
  });

  it("A's tombstone does not change what B's bot auto-fills for the same phones", async () => {
    await seedSavedAndSettled('pa', '000011112222 HDFC0000001');
    await seedSavedAndSettled('pb', '000033334444 ICIC0000001');
    await createRecipientRepo(db).tombstoneRecipient('pa', SENDER, RP);
    expect(await resolveStoredPayout(toolCtx('pb', SENDER), RP, 'IN')).toEqual({ payoutMethod: 'bank', payoutDestination: '000033334444 ICIC0000001' });
  });

  it('past transfers to the recipient are untouched (select * deep-equal before and after)', async () => {
    await seedSavedAndSettled('pa', '000011112222 HDFC0000001');
    const before = await db.select().from(transfers).orderBy(transfers.id);
    await createRecipientRepo(db).tombstoneRecipient('pa', SENDER, RP);
    expect(await db.select().from(transfers).orderBy(transfers.id)).toEqual(before);
  });
});

describe('schedule repo: listForCustomer', () => {
  it('returns only this (partner, phone) schedules', async () => {
    const repo = createScheduleRepo(db);
    const base = (partnerId: string, phone: string): Schedule => ({
      id: `s_${newTransferId()}`,
      phone,
      amountUsd: 25,
      recipientName: 'Test Recipient',
      recipientPhone: RP,
      payoutMethod: 'bank',
      payoutDestination: '000011112222',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 1,
      status: 'active',
      createdAt: new Date().toISOString(),
      partnerId,
      sourceCurrency: 'USD',
      amountSource: 25,
    });
    const a = base('pa', SENDER);
    await repo.saveSchedule(a);
    await repo.saveSchedule(base('pb', SENDER));
    await repo.saveSchedule(base('pa', SENDER_2));
    expect((await repo.listForCustomer('pa', SENDER)).map((s) => s.id)).toEqual([a.id]);
  });
});
