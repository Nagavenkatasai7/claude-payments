import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// UI redesign M3-15b: the tenant-scoped dead-letter reads/writes behind the partner's Replay button.
// A tenant sees and revives ONLY dead settlement.instruct rows whose transfer settles on ITS rail
// (coalesce(settlement_partner_id, partner_id)), never another tenant's and never another kind. The
// reads return { id, createdAt, attempts } only: never the payload or last_error. The unscoped
// retryDead (ops) is not used.

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;

function transfer(id: string, partnerId: string, extra: Partial<Transfer> = {}): Transfer {
  return {
    id, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId,
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...extra,
  } as Transfer;
}

async function deadRow(kind: string, payload: Record<string, unknown>, key: string): Promise<number> {
  await outbox.enqueue(kind as never, payload, { dedupeKey: key });
  const r = (await db.execute(sql`
    UPDATE outbox SET status = 'dead', attempts = 8, last_error = 'Settlement instruction rejected (500) for 15551230000',
                      lease_owner = 'wX', lease_until = now()
    WHERE dedupe_key = ${key} RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
  return Number(r.rows[0].id);
}
const statusOf = async (id: number) =>
  ((await db.execute(sql`SELECT status, attempts, last_error, lease_owner, lease_until FROM outbox WHERE id = ${id}`)) as unknown as {
    rows: Array<{ status: string; attempts: number; last_error: string | null; lease_owner: string | null; lease_until: unknown }>;
  }).rows[0];

let paRow: number;
let pbRow: number;
let routedToPa: number;
let paWhatsapp: number;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  await store.saveTransfer(transfer('t_pa', 'pa'));
  await store.saveTransfer(transfer('t_pb', 'pb'));
  // Owned by pb but ROUTED to pa's rail: pa's endpoint was called, so it is pa's delivery.
  await store.saveTransfer(transfer('t_routed', 'pb', { settlementPartnerId: 'pa' }));
  paRow = await deadRow('settlement.instruct', { transferId: 't_pa' }, 'instruct:t_pa');
  pbRow = await deadRow('settlement.instruct', { transferId: 't_pb' }, 'instruct:t_pb');
  routedToPa = await deadRow('settlement.instruct', { transferId: 't_routed' }, 'instruct:t_routed');
  paWhatsapp = await deadRow('whatsapp.text', { transferId: 't_pa', to: '15551230000', text: 'hi', partnerId: 'pa' }, 'wa:t_pa');
});

describe('listDeadInstructionsForPartner', () => {
  it("pa sees its own dead instruct rows (incl. those routed to its rail), never pb's, never another kind", async () => {
    const pa = await outbox.listDeadInstructionsForPartner('pa', 50);
    expect(pa.map((r) => r.id).sort()).toEqual([paRow, routedToPa].sort());
    const pb = await outbox.listDeadInstructionsForPartner('pb', 50);
    expect(pb.map((r) => r.id)).toEqual([pbRow]);
    expect(pa.map((r) => r.id)).not.toContain(paWhatsapp);
  });

  it('returns { id, createdAt, attempts } ONLY: never the payload or last_error', async () => {
    const [r] = await outbox.listDeadInstructionsForPartner('pb', 50);
    expect(Object.keys(r).sort()).toEqual(['attempts', 'createdAt', 'id']);
    expect(r.attempts).toBe(8);
    expect(r.createdAt).toBeInstanceOf(Date);
    expect(JSON.stringify(r)).not.toContain('15551230000');
  });

  it('a non-dead row is not listed; the limit is clamped (1..100)', async () => {
    await store.saveTransfer(transfer('t_pa2', 'pa'));
    await outbox.enqueue('settlement.instruct', { transferId: 't_pa2' }, { dedupeKey: 'instruct:t_pa2' }); // pending
    expect((await outbox.listDeadInstructionsForPartner('pa', 50)).length).toBe(2);
    expect((await outbox.listDeadInstructionsForPartner('pa', 1)).length).toBe(1);
    expect((await outbox.listDeadInstructionsForPartner('pa', 0)).length).toBe(1);
    expect((await outbox.listDeadInstructionsForPartner('pa', Number.NaN)).length).toBe(1);
  });

  it('a row whose transfer is missing belongs to nobody', async () => {
    const orphan = await deadRow('settlement.instruct', { transferId: 'gone' }, 'instruct:gone');
    expect((await outbox.listDeadInstructionsForPartner('pa', 50)).map((r) => r.id)).not.toContain(orphan);
    expect(await outbox.retryDeadForPartner(orphan, 'pa')).toBe(false);
  });
});

describe('only a row that could still be needed is listed or revived (review MEDIUM)', () => {
  it('a transfer the rail already acknowledged (payment_provider_ref set) is excluded: not listed, not revived', async () => {
    await db.execute(sql`UPDATE transfers SET payment_provider_ref = 'rail-ack' WHERE id = 't_pa'`);
    expect((await outbox.listDeadInstructionsForPartner('pa', 50)).map((r) => r.id)).not.toContain(paRow);
    expect(await outbox.retryDeadForPartner(paRow, 'pa')).toBe(false);
    expect((await statusOf(paRow)).status).toBe('dead');
  });

  it.each(['delivered', 'cancelled'])('a %s transfer is excluded (nothing left to instruct)', async (status) => {
    await db.execute(sql`UPDATE transfers SET status = ${status} WHERE id = 't_pa'`);
    expect((await outbox.listDeadInstructionsForPartner('pa', 50)).map((r) => r.id)).not.toContain(paRow);
    expect(await outbox.retryDeadForPartner(paRow, 'pa')).toBe(false);
  });

  it('a dead row with a LIVE sibling instruct row for the same transfer is excluded (never two in flight)', async () => {
    await outbox.enqueue('settlement.instruct', { transferId: 't_pa' }, { dedupeKey: 'reinstruct:t_pa' }); // pending
    expect((await outbox.listDeadInstructionsForPartner('pa', 50)).map((r) => r.id)).not.toContain(paRow);
    expect(await outbox.retryDeadForPartner(paRow, 'pa')).toBe(false);
  });

  it('two dead siblings: reviving one hides and blocks the other', async () => {
    const sibling = await deadRow('settlement.instruct', { transferId: 't_pa' }, 'reinstruct:t_pa');
    expect((await outbox.listDeadInstructionsForPartner('pa', 50)).map((r) => r.id)).toEqual(expect.arrayContaining([paRow, sibling]));
    expect(await outbox.retryDeadForPartner(paRow, 'pa')).toBe(true);
    expect((await outbox.listDeadInstructionsForPartner('pa', 50)).map((r) => r.id)).not.toContain(sibling);
    expect(await outbox.retryDeadForPartner(sibling, 'pa')).toBe(false);
    expect((await statusOf(sibling)).status).toBe('dead');
  });

  it('a revived row keeps locked_at, so a later sender cancel escalates (rail_claimed) instead of auto-cancelling', async () => {
    await db.execute(sql`UPDATE outbox SET locked_at = now() WHERE id = ${paRow}`); // it ran before it died
    expect(await outbox.retryDeadForPartner(paRow, 'pa')).toBe(true);
    const r = (await db.execute(sql`SELECT locked_at FROM outbox WHERE id = ${paRow}`)) as unknown as { rows: Array<{ locked_at: unknown }> };
    expect(r.rows[0].locked_at).not.toBeNull();
    await createOutboxRepo(db).enqueue('whatsapp.text', { to: '15551230000', text: 'x', partnerId: 'pa' }, { dedupeKey: 'stage1:t_pa' });
    const { cancelPaidBySenderLocked } = await import('@/lib/sender-cancel');
    const claim = await db.transaction((tx) => cancelPaidBySenderLocked(tx, 'pa', 't_pa'));
    expect(claim.kind).toBe('escalate');
    expect((claim as { reason?: string }).reason).toBe('rail_claimed');
  });
});

describe('retryDeadForPartner', () => {
  it("pa cannot revive pb's row: false, and it stays dead", async () => {
    expect(await outbox.retryDeadForPartner(pbRow, 'pa')).toBe(false);
    expect((await statusOf(pbRow)).status).toBe('dead');
  });

  it('its own row: true, then false (the status guard makes a double submit a no-op)', async () => {
    expect(await outbox.retryDeadForPartner(paRow, 'pa')).toBe(true);
    expect(await statusOf(paRow)).toMatchObject({ status: 'pending', attempts: 0, last_error: null, lease_owner: null, lease_until: null });
    expect(await outbox.retryDeadForPartner(paRow, 'pa')).toBe(false);
    expect((await statusOf(paRow)).status).toBe('pending');
  });

  it('a row routed to its rail can be revived by the rail owner, not by the transfer owner', async () => {
    expect(await outbox.retryDeadForPartner(routedToPa, 'pb')).toBe(false);
    expect(await outbox.retryDeadForPartner(routedToPa, 'pa')).toBe(true);
  });

  it('a dead whatsapp.text row is never retried', async () => {
    expect(await outbox.retryDeadForPartner(paWhatsapp, 'pa')).toBe(false);
    expect((await statusOf(paWhatsapp)).status).toBe('dead');
  });

  it('a revived row is claimable again, due now', async () => {
    await outbox.retryDeadForPartner(paRow, 'pa');
    const claimed = await outbox.claimBatch(10, 'w1');
    expect(claimed.map((r) => r.id)).toEqual([paRow]);
  });
});
