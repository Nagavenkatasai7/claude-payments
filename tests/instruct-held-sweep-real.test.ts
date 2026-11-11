import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, paidRealMoneyTransfer, seedRealMoneyRail } from './helpers-live';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep } from '@/lib/reconcile';
import { escalateStuckPaid } from '@/lib/stale-money';
import { stuckHeldMessage } from '@/lib/instruct-gates';
import { invalidateFlagCache } from '@/lib/flags';
import type { Db } from '@/db/client';

// Fix pack 5 T14 (P9, C6/M8): the stuck-paid sweeps with the REAL helpers
// (nothing mocked). A row G14 holds on purpose is never re-instructed; while
// its instruct row is live the worker's own alert owns it, and with none (a
// mockfund row's instruct is DONE) ONE <reason>:stuck:<id> alert is raised.

const ID = 'hsr_t1';

let db: Db;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();

function deps(): WorkerDeps {
  return {
    db,
    store: createStore(fakeRedis(), db),
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
const alerts = () => rows<{ k: string; m: string }>(sql`SELECT dedupe_key AS k, payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
const alertKeys = async () => (await alerts()).map((a) => a.k);
const instructKeys = async () =>
  (await rows<{ k: string }>(sql`SELECT dedupe_key AS k FROM outbox WHERE kind = 'settlement.instruct' ORDER BY id`)).map((r) => r.k);
const auditCount = async (action: string) =>
  Number((await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = ${action}`))[0].n);
const enqueueInstruct = () => outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });
// Stuck for 2 hours: past reconcile's 15 minutes and stale-money's first (1 h) rung.
const stuckTwoHours = () => db.execute(sql`UPDATE transfers SET paid_at = now() - interval '2 hours' WHERE id = ${ID}`);

beforeEach(async () => {
  db = await freshDb();
  invalidateFlagCache(db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  await seedRealMoneyRail(db, 'acme');
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
});
afterEach(() => invalidateFlagCache(db));

describe('stuck-paid sweeps and G14 (real helpers, pack 5 T14)', { retry: 0 }, () => {
  it('mockfund row, instruct done, paid >15m: one mockfund:stuck:<id> alert, no re-instruct', async () => {
    await certifyPartnerForTest(db, 'acme');
    await paidRealMoneyTransfer(db, { id: ID, fundingProvider: 'mock', fundingRef: `mockfund-${ID}` });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await instructKeys()).toEqual([`instruct:${ID}`]);
    await stuckTwoHours();

    const r = await reconcileSweep(db);
    expect(r.reinstructed).toBe(0);
    expect(await instructKeys()).toEqual([`instruct:${ID}`]);
    const a = await alerts();
    expect(a.map((x) => x.k)).toEqual([`mockfund:${ID}`, `mockfund:stuck:${ID}`]);
    expect(a.filter((x) => x.k.startsWith('recon:'))).toEqual([]);
    const stuck = a.find((x) => x.k === `mockfund:stuck:${ID}`);
    expect(stuck?.m).toBe(stuckHeldMessage(ID, 'mockfund'));
    expect(stuck?.m).toContain('Issue refund');
    expect(stuck?.m).toContain(`nofunds-${ID}`);

    await reconcileSweep(db);
    expect(await alertKeys()).toEqual([`mockfund:${ID}`, `mockfund:stuck:${ID}`]);

    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alertKeys()).toEqual([`mockfund:${ID}`, `mockfund:stuck:${ID}`]);
    expect(await auditCount('transfer.stuck_escalated')).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fundmode row whose deferred instruct row is still pending: no stuck alert, no re-instruct', async () => {
    await certifyPartnerForTest(db, 'acme', { fundingMode: null });
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect((await rows<{ s: string }>(sql`SELECT status AS s FROM outbox WHERE dedupe_key = ${`instruct:${ID}`}`))[0].s).toBe('pending');
    await stuckTwoHours();

    expect((await reconcileSweep(db)).reinstructed).toBe(0);
    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alertKeys()).toEqual([`fundmode:${ID}`]);
    expect(await instructKeys()).toEqual([`instruct:${ID}`]);
    expect(await auditCount('transfer.stuck_escalated')).toBe(0);
  });

  it('fundmode row with no live instruct row (dead-lettered by an older build): one fundmode:stuck:<id> alert', async () => {
    await certifyPartnerForTest(db, 'acme', { fundingMode: null });
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    await db.execute(sql`UPDATE outbox SET status = 'dead' WHERE dedupe_key = ${`instruct:${ID}`}`);
    await stuckTwoHours();

    expect((await reconcileSweep(db)).reinstructed).toBe(0);
    const a = await alerts();
    expect(a).toEqual([{ k: `fundmode:stuck:${ID}`, m: stuckHeldMessage(ID, 'fundmode') }]);
    expect(await escalateStuckPaid(db)).toBe(0);
    expect(await alertKeys()).toEqual([`fundmode:stuck:${ID}`]);
    expect(await instructKeys()).toEqual([`instruct:${ID}`]);
  });

  it('a blocked row: no stuck alert', async () => {
    await certifyPartnerForTest(db, 'acme');
    await paidRealMoneyTransfer(db, { id: ID, fundingProvider: 'mock', fundingRef: `mockfund-${ID}` });
    await db.execute(sql`UPDATE transfers SET compliance_status = 'blocked' WHERE id = ${ID}`);
    await stuckTwoHours();
    await reconcileSweep(db);
    await escalateStuckPaid(db);
    expect((await alertKeys()).filter((k) => k.includes(':stuck:'))).toEqual([]);
    expect(await instructKeys()).toEqual([]);
  });
});
