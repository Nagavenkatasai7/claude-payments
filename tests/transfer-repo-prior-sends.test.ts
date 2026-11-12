import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { captureQueries, freshDb, seedLedgerSpend, seedPartner, seedPriorSends } from './helpers-db';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import type { Db } from '@/db/client';
import type { TransferStatus } from '@/lib/types';

// Fix pack 6 (P14): the ONE "known sender / known recipient" rule for R47 (AML
// holds in the mint) and R48 (risk signals). Only rows whose money really
// moved count: paid or delivered, refund not completed, same tenant, same
// environment, strictly before the anchor when one is given.

const DAY = 86_400_000;
const PHONE = '15550002222';
const OTHER_PHONE = '15550003333';
const RECIPIENT = '919000000043';
let db: Db;
let now: number;

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'p2');
  now = Date.now();
});

const ago = (ms: number) => new Date(now - ms);

describe('priorSends', () => {
  it('counts paid and delivered rows only', async () => {
    const statuses: TransferStatus[] = ['awaiting_payment', 'in_review', 'cancelled', 'blocked', 'paid', 'delivered'];
    for (const [i, status] of statuses.entries()) {
      await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status, recipientPhone: RECIPIENT, createdAt: ago((i + 1) * DAY) });
    }
    expect(await createTransferRepo(db).priorSends('default', PHONE, RECIPIENT)).toEqual({ total: 2, toRecipient: 2 });
  });

  it('a refunded row (refund_status completed) does not count; a failed refund still counts', async () => {
    const refunded = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: ago(2 * DAY) });
    const failed = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: ago(3 * DAY) });
    const pending = await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'delivered', recipientPhone: RECIPIENT, createdAt: ago(4 * DAY) });
    await db.execute(sql`UPDATE transfers SET refund_status = 'completed' WHERE id = ${refunded}`);
    await db.execute(sql`UPDATE transfers SET refund_status = 'failed' WHERE id = ${failed}`);
    await db.execute(sql`UPDATE transfers SET refund_status = 'pending' WHERE id = ${pending}`);
    expect(await createTransferRepo(db).priorSends('default', PHONE, RECIPIENT)).toEqual({ total: 2, toRecipient: 2 });
  });

  it("tenant-scoped: another partner's rows and another sender's rows never count", async () => {
    await seedLedgerSpend(db, { partnerId: 'p2', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: ago(DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: OTHER_PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: ago(DAY) });
    const repo = createTransferRepo(db);
    expect(await repo.priorSends('default', PHONE, RECIPIENT)).toEqual({ total: 0, toRecipient: 0 });
    expect(await repo.priorSends('p2', PHONE, RECIPIENT)).toEqual({ total: 1, toRecipient: 1 });
  });

  it("environment-scoped: 'test' rows never count for 'live' (the default); environment 'test' counts only test rows", async () => {
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, environment: 'test', createdAt: ago(DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, environment: 'test', createdAt: ago(2 * DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'delivered', recipientPhone: RECIPIENT, createdAt: ago(3 * DAY) });
    const repo = createTransferRepo(db);
    expect(await repo.priorSends('default', PHONE, RECIPIENT)).toEqual({ total: 1, toRecipient: 1 });
    expect(await repo.priorSends('default', PHONE, RECIPIENT, 'live')).toEqual({ total: 1, toRecipient: 1 });
    expect(await repo.priorSends('default', PHONE, RECIPIENT, 'test')).toEqual({ total: 2, toRecipient: 2 });
  });

  it("toRecipient compares digits: a stored '+91 90000 00043' matches '919000000043', and a formatted input matches stored digits; another number does not", async () => {
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: '+91 90000 00043', createdAt: ago(DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: '919000000043', createdAt: ago(2 * DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: '919000000099', createdAt: ago(3 * DAY) });
    const repo = createTransferRepo(db);
    expect(await repo.priorSends('default', PHONE, '919000000043')).toEqual({ total: 3, toRecipient: 2 });
    expect(await repo.priorSends('default', PHONE, '+91-90000-00043')).toEqual({ total: 3, toRecipient: 2 });
    expect(await repo.priorSends('default', PHONE, '919000000077')).toEqual({ total: 3, toRecipient: 0 });
  });

  it('an empty or digit-less recipient phone gives toRecipient null, total still counted', async () => {
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: '', createdAt: ago(DAY) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: ago(2 * DAY) });
    const repo = createTransferRepo(db);
    expect(await repo.priorSends('default', PHONE, '')).toEqual({ total: 2, toRecipient: null });
    expect(await repo.priorSends('default', PHONE, '+-')).toEqual({ total: 2, toRecipient: null });
  });

  it('before: strictly before (created_at, id); same-timestamp rows ordered by id; no before = every row', async () => {
    const repo = createTransferRepo(db);
    const at = ago(DAY);
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: at, id: 'tr_a' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: at, id: 'tr_b' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 100, status: 'paid', recipientPhone: RECIPIENT, createdAt: ago(1000) });
    expect(await repo.priorSends('default', PHONE, RECIPIENT, 'live', { at, id: 'tr_a' })).toEqual({ total: 0, toRecipient: 0 });
    expect(await repo.priorSends('default', PHONE, RECIPIENT, 'live', { at, id: 'tr_b' })).toEqual({ total: 1, toRecipient: 1 });
    expect(await repo.priorSends('default', PHONE, RECIPIENT, 'live', { at: ago(500), id: 'tr_z' })).toEqual({ total: 3, toRecipient: 3 });
    expect(await repo.priorSends('default', PHONE, RECIPIENT)).toEqual({ total: 3, toRecipient: 3 });
  });

  it('one statement, tenant column in the WHERE', async () => {
    const stop = captureQueries();
    await createTransferRepo(db).priorSends('default', PHONE, RECIPIENT);
    const log = stop();
    expect(log).toHaveLength(1);
    expect(log[0].sql.toLowerCase().startsWith('select')).toBe(true);
    expect(log[0].sql).toContain('"partner_id"');
    expect(log[0].sql).toContain('"environment"');
    expect(log[0].params).toContain('default');
  });
});

describe('seedPriorSends (P24)', () => {
  it('seeds paid rows on relative days, the first toRecipient of them to the recipient, the rest elsewhere', async () => {
    const ids = await seedPriorSends(db, 'p2', PHONE, { paid: 3, toRecipient: 2, recipientPhone: RECIPIENT });
    expect(ids).toHaveLength(3);
    expect(await createTransferRepo(db).priorSends('p2', PHONE, RECIPIENT)).toEqual({ total: 3, toRecipient: 2 });
    const rows = await db.execute(sql`SELECT status, environment, amount_usd, created_at FROM transfers WHERE partner_id = 'p2' ORDER BY created_at DESC`);
    const r = rows.rows as Array<{ status: string; environment: string; amount_usd: string; created_at: string | Date }>;
    expect(r.map((x) => x.status)).toEqual(['paid', 'paid', 'paid']);
    expect(r.map((x) => x.environment)).toEqual(['live', 'live', 'live']);
    for (const x of r) expect(new Date(x.created_at).getTime()).toBeLessThan(now - DAY + 60_000);
  });

  it('amountUsd sets every seeded row', async () => {
    await seedPriorSends(db, 'default', PHONE, { paid: 2, toRecipient: 0, recipientPhone: RECIPIENT, amountUsd: 250 });
    const rows = await db.execute(sql`SELECT amount_usd FROM transfers WHERE phone = ${PHONE}`);
    expect((rows.rows as Array<{ amount_usd: string | number }>).map((x) => Number(x.amount_usd))).toEqual([250, 250]);
    expect(await createTransferRepo(db).priorSends('default', PHONE, RECIPIENT)).toEqual({ total: 2, toRecipient: 0 });
  });
});
