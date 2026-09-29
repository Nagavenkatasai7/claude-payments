import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { outbox as outboxTable, partnerWebhookDeliveries } from '@/db/schema';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep } from '@/lib/reconcile';
import { replayDeadInstruction } from '@/lib/partner-webhook-replay';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// UI redesign M3-15b: what a partner Replay does to MONEY. The replay only re-queues the dead row
// through the normal outbox path (no inline send); the worker's ledger guard then decides:
//   • an already-delivered transfer → the row is done WITHOUT a POST (and no delivery row);
//   • a still-paid transfer → exactly ONE re-POST carrying the same transfer id (not a no-op: the
//     partner endpoint must be idempotent on the transfer id, per the page copy and the M4 docs);
//   • reconcileSweep keeps its ONE re-instruction per transfer (dedupe key `reinstruct:<id>`): a
//     replayed row never makes it enqueue a second one.

let db: Db;
let store: ReturnType<typeof createStore>;
const redis = fakeRedis();
const fetchFn = vi.fn();
const actor = { username: 'pa-admin', actorScope: 'partner' as const };

const rail = (): PartnerIntegrations => ({
  kyc: {},
  payment: { providerType: 'http', credentials: { settlementUrl: 'https://rail.example.com/instruct', signingSecret: 'a'.repeat(64) }, webhookSecret: 'b'.repeat(64) },
  whatsapp: {},
});
function transfer(extra: Partial<Transfer> = {}): Transfer {
  return {
    id: 'rp_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 50 * 60_000).toISOString(), partnerId: 'pa',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...extra,
  } as Transfer;
}
function deps(): WorkerDeps {
  return {
    db, store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}
async function deadRow(key: string): Promise<number> {
  await createOutboxRepo(db).enqueue('settlement.instruct', { transferId: 'rp_t1' }, { dedupeKey: key });
  const r = (await db.execute(sql`UPDATE outbox SET status = 'dead', attempts = 8 WHERE dedupe_key = ${key} RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
  return Number(r.rows[0].id);
}
const instructRows = () =>
  db.select({ id: outboxTable.id, key: outboxTable.dedupeKey, status: outboxTable.status }).from(outboxTable).where(eq(outboxTable.kind, 'settlement.instruct')).orderBy(asc(outboxTable.id));
const statusOf = async (id: number) => (await instructRows()).find((r) => r.id === id)?.status;
const posts = () => fetchFn.mock.calls.map((c) => JSON.parse(String((c as [string, RequestInit])[1].body)) as Record<string, unknown>);

beforeEach(async () => {
  redis.dump.clear();
  fetchFn.mockReset();
  fetchFn.mockImplementation(async () => new Response(JSON.stringify({ providerRef: 'rail-rp' }), { status: 200 }));
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'pa', 'Partner A');
  await createPartnerIntegrationsStore(db).saveIntegrations('pa', rail());
});

describe('replayDeadInstruction → the worker', { retry: 0 }, () => {
  it('the dead row of an already-DELIVERED transfer is not replayable at all (not_found, stays dead, no POST)', async () => {
    await store.saveTransfer(transfer({ status: 'delivered' }));
    const id = await deadRow('instruct:rp_t1');
    expect(await replayDeadInstruction(db, 'pa', actor, id, { redis })).toEqual({ ok: false, reason: 'not_found' });
    await drainOnce(deps(), 'w1');
    expect(await statusOf(id)).toBe('dead');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a transfer DELIVERED after the replay was queued: the worker ledger guard marks the row done with NO POST and no delivery row', async () => {
    await store.saveTransfer(transfer());
    const id = await deadRow('instruct:rp_t1');
    expect(await replayDeadInstruction(db, 'pa', actor, id, { redis })).toEqual({ ok: true });
    expect(fetchFn).not.toHaveBeenCalled(); // the replay itself never sends
    await db.execute(sql`UPDATE transfers SET status = 'delivered' WHERE id = 'rp_t1'`);
    await drainOnce(deps(), 'w1');
    expect(await statusOf(id)).toBe('done');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await db.select().from(partnerWebhookDeliveries)).toHaveLength(0);
  });

  it('the replay locks the transfer row FOR UPDATE before reviving (serialises sibling replays and sender cancel)', async () => {
    await store.saveTransfer(transfer());
    const id = await deadRow('instruct:rp_t1');
    const stop = captureQueries();
    expect(await replayDeadInstruction(db, 'pa', actor, id, { redis })).toEqual({ ok: true });
    const q = stop().map((x) => x.sql.toLowerCase());
    const lock = q.findIndex((x) => x.includes('transfers') && x.includes('for update'));
    const revive = q.findIndex((x) => x.startsWith('update "outbox"'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(revive);
  });

  it('replaying the dead row of a still-PAID transfer re-POSTs exactly once, carrying the same transfer id', async () => {
    await store.saveTransfer(transfer());
    const id = await deadRow('instruct:rp_t1');
    expect(await replayDeadInstruction(db, 'pa', actor, id, { redis })).toEqual({ ok: true });
    expect(fetchFn).not.toHaveBeenCalled();
    await drainOnce(deps(), 'w1');
    await drainOnce(deps(), 'w1');
    expect(posts().map((b) => b.reference)).toEqual(['rp_t1']);
    expect(await statusOf(id)).toBe('done');
    const [d] = await db.select().from(partnerWebhookDeliveries);
    expect(d).toMatchObject({ partnerId: 'pa', subjectId: 'rp_t1', outboxId: id, attempt: 1, outcome: 'ok' });
  });
});

describe('replay × reconcileSweep (one re-instruction per transfer: dedupe key reinstruct:<id>)', { retry: 0 }, () => {
  it('when the sweep already used its re-instruction, a replayed row makes it enqueue NOTHING more', async () => {
    await store.saveTransfer(transfer());
    const original = await deadRow('instruct:rp_t1');
    await deadRow('reinstruct:rp_t1'); // the sweep's one recovery row, also dead
    expect(await replayDeadInstruction(db, 'pa', actor, original, { redis })).toEqual({ ok: true });
    await reconcileSweep(db);
    await reconcileSweep(db);
    expect((await instructRows()).map((r) => [r.key, r.status])).toEqual([
      ['instruct:rp_t1', 'pending'],
      ['reinstruct:rp_t1', 'dead'],
    ]);
  });

  it('with the replayed row pending or done, repeated sweeps add at most the ONE reinstruct row, ever', async () => {
    await store.saveTransfer(transfer());
    const original = await deadRow('instruct:rp_t1');
    expect(await replayDeadInstruction(db, 'pa', actor, original, { redis })).toEqual({ ok: true });
    await reconcileSweep(db); // pending replayed row
    fetchFn.mockImplementation(async () => new Response('down', { status: 503 })); // the rail stays silent: still paid
    await drainOnce(deps(), 'w1');
    await reconcileSweep(db);
    await reconcileSweep(db);
    const keys = (await instructRows()).map((r) => r.key);
    expect(keys.filter((k) => k === 'reinstruct:rp_t1')).toHaveLength(1);
    expect(keys).toHaveLength(2);
  });
});

describe('replayDeadInstruction refusals', () => {
  it('a row of another rail owner, a missing id or a non-dead row → not_found, nothing written', async () => {
    await seedPartner(db, 'pb', 'Partner B');
    await store.saveTransfer(transfer({ partnerId: 'pb' }));
    const pbRow = await deadRow('instruct:rp_t1');
    expect(await replayDeadInstruction(db, 'pa', actor, pbRow, { redis })).toEqual({ ok: false, reason: 'not_found' });
    expect(await replayDeadInstruction(db, 'pa', actor, 424242, { redis })).toEqual({ ok: false, reason: 'not_found' });
    expect(await statusOf(pbRow)).toBe('dead');
  });
});
