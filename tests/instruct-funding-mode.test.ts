import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, paidRealMoneyTransfer, seedRealMoneyRail } from './helpers-live';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { INSTRUCT_FUNDING_MODE_DEFER_SEC } from '@/lib/instruct-errors';
import { invalidateFlagCache } from '@/lib/flags';
import { env } from '@/lib/env';
import type { Db } from '@/db/client';

// Fix pack 5 T14 (P8 G14, P17): on a real-money rail the worker never
// instructs a row whose sender money was not really collected (a mock-class
// row: done + ONE mockfund:<id>, never retried), or whose funding class does
// not match the OWNER partner's recorded funding mode (deferred UNCHARGED
// 900 s + ONE fundmode:<id>). A failed owner read is a charged retry. Not real
// money (simulator) is unchanged.

// The owner read seam: getPartner throws from call number `failFrom` on (the
// live gate's rail-partner read is call 1, so failFrom 2 hits only G14's read).
const partnerSeam = vi.hoisted(() => ({ failFrom: 0, calls: 0 }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (dbx: Parameters<typeof real.createPartnerRepo>[0]) => {
      const r = real.createPartnerRepo(dbx);
      return {
        ...r,
        getPartner: async (id: string) => {
          partnerSeam.calls += 1;
          if (partnerSeam.failFrom > 0 && partnerSeam.calls >= partnerSeam.failFrom) throw new RangeError('partner read failed');
          return r.getPartner(id);
        },
      };
    },
  };
});

const ID = 'fm_t1';
const RAIL_URL = 'https://rail.acme-test.com/settle';

const mockfundText = (id: string, owner: string, rail: string) =>
  `⚠️ SmartRemit ops: transfer ${id} (partner ${owner}, rail ${rail}) is PAID but was not instructed: it was funded by the demo (mock) funding provider on a real-money rail, so no real money was collected here. It will never be sent. Close it with Issue refund in the dashboard: it completes as nofunds-${id} without moving money. Check with the partner how the sender paid.`;
const fundmodeText = (id: string, owner: string, rail: string, cls: string, mode: string) =>
  `transfer ${id} (partner ${owner}, rail ${rail}) is paid but was not instructed: its funding (${cls}) does not match the partner's recorded funding mode (${mode}). It waits and is checked every 15 minutes. Record the right funding mode on the partner's go-live card, or return the sender's money with Issue refund in the dashboard (Cancel does not apply to a paid transfer).`;

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();

function deps(): WorkerDeps {
  return {
    db,
    store,
    sendText: vi.fn(async () => {}) as unknown as WorkerDeps['sendText'],
    sendTemplate: vi.fn(async () => {}) as unknown as WorkerDeps['sendTemplate'],
    fetchFn: fetchFn as unknown as typeof fetch,
    recipientTemplateName: 'transfer_delivered',
    recipientTemplateLang: 'en',
    listStaff: async () => [],
    runAgentTurn: vi.fn(async () => '') as unknown as WorkerDeps['runAgentTurn'],
  };
}

type RowState = { status: string; attempts: number; last_error: string | null; backoff_s: number };
async function rowState(): Promise<RowState> {
  const r = (await db.execute(sql`
    SELECT status, attempts, last_error,
           round(extract(epoch FROM (next_attempt_at - now())))::int AS backoff_s
    FROM outbox WHERE dedupe_key = ${`instruct:${ID}`}`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}
async function alerts(): Promise<Array<{ k: string; m: string }>> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k, payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string; m: string }>;
  };
  return r.rows;
}
const alertKeys = async () => (await alerts()).map((a) => a.k);
const enqueueInstruct = () => outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `instruct:${ID}` });
const dueNow = () => db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);

function expectDeferred(st: RowState) {
  expect(st).toMatchObject({ status: 'pending', attempts: 0, last_error: null });
  expect(st.backoff_s).toBeGreaterThanOrEqual(INSTRUCT_FUNDING_MODE_DEFER_SEC - 5);
  expect(st.backoff_s).toBeLessThanOrEqual(INSTRUCT_FUNDING_MODE_DEFER_SEC + 5);
}
function expectPosted() {
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect((fetchFn.mock.calls[0] as [string])[0]).toBe(RAIL_URL);
}
async function expectNoPii() {
  for (const a of await alerts()) {
    for (const pii of ['15551239876', 'Test Sender', 'Test Recipient', '919800000999', '123456789012', 'HDFC']) {
      expect(a.m).not.toContain(pii);
    }
  }
}

beforeEach(async () => {
  partnerSeam.failFrom = 0;
  partnerSeam.calls = 0;
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  await seedRealMoneyRail(db, 'acme');
  fetchFn.mockReset();
  fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
});
afterEach(() => invalidateFlagCache(db));

describe('settlement.instruct funding_mode gate G14 (pack 5 T14)', { retry: 0 }, () => {
  it('a mock-class row (funding_provider mock) on a real-money rail: done, no POST, one mockfund:<id> alert, transfer still paid, no providerRef', async () => {
    await certifyPartnerForTest(db, 'acme');
    await paidRealMoneyTransfer(db, { id: ID, fundingProvider: 'mock', fundingRef: `mockfund-${ID}` });
    await enqueueInstruct();
    const r = await drainOnce(deps(), 'w1');
    expect(r).toMatchObject({ processed: 1, failed: 0, released: 0, dead: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await rowState()).status).toBe('done');
    expect(await alerts()).toEqual([{ k: `mockfund:${ID}`, m: mockfundText(ID, 'acme', 'acme') }]);
    const t = await store.getTransfer(ID);
    expect(t?.status).toBe('paid');
    const ref = (await db.execute(sql`SELECT payment_provider_ref AS r FROM transfers WHERE id = ${ID}`)) as unknown as { rows: Array<{ r: string | null }> };
    expect(ref.rows[0].r).toBeNull();
    await expectNoPii();

    // A re-enqueued instruct (a reconcile reinstruct or a dead-letter Retry): no second alert.
    await outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: `reinstruct:${ID}` });
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await alertKeys()).filter((k) => k.startsWith('mockfund:'))).toEqual([`mockfund:${ID}`]);
  });

  it('NULL provider with a fundingRef (an older build\'s charge) is mock too', async () => {
    await certifyPartnerForTest(db, 'acme');
    await paidRealMoneyTransfer(db, { id: ID, fundingRef: `mockfund-${ID}` });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await rowState()).status).toBe('done');
    expect(await alertKeys()).toEqual([`mockfund:${ID}`]);
  });

  it('partner_collected row, owner fundingMode partner_collected: POSTed', async () => {
    await certifyPartnerForTest(db, 'acme');
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expectPosted();
    expect((await rowState()).status).toBe('done');
    expect(await alertKeys()).toEqual([]);
  });

  it('partner_collected row, owner record absent: deferred uncharged ~900 s, one fundmode:<id> alert, no railfail:, no instructnotlive:', async () => {
    await certifyPartnerForTest(db, 'acme', { fundingMode: null });
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    expect(await drainOnce(deps(), 'w1')).toMatchObject({ processed: 0, failed: 0, released: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expectDeferred(await rowState());
    expect(await alerts()).toEqual([{ k: `fundmode:${ID}`, m: fundmodeText(ID, 'acme', 'acme', 'partner_collected', 'none') }]);
    await expectNoPii();

    await dueNow();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expectDeferred(await rowState());
    expect(await alertKeys()).toEqual([`fundmode:${ID}`]);
  });

  it('stripe row (funding_state succeeded), owner partner_collected: deferred + fundmode:; with owner partner_psp: POSTed', async () => {
    await certifyPartnerForTest(db, 'acme');
    await paidRealMoneyTransfer(db, { id: ID, fundingProvider: 'stripe', fundingRef: 'pi_test_1', fundingMethod: 'debit_card' });
    await db.execute(sql`UPDATE transfers SET funding_state = 'succeeded' WHERE id = ${ID}`);
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expectDeferred(await rowState());
    expect(await alerts()).toEqual([{ k: `fundmode:${ID}`, m: fundmodeText(ID, 'acme', 'acme', 'stripe', 'partner_collected') }]);

    await certifyPartnerForTest(db, 'acme', { fundingMode: 'partner_psp' });
    await dueNow();
    await drainOnce(deps(), 'w1');
    expectPosted();
    expect((await rowState()).status).toBe('done');
  });

  it("routed row: the OWNER's record decides, not the rail partner's", async () => {
    await seedPartner(db, 'railp');
    await seedRealMoneyRail(db, 'railp', { url: 'https://railp.acme-test.com/settle' });
    await certifyPartnerForTest(db, 'acme', { fundingMode: null });
    await certifyPartnerForTest(db, 'railp');
    await paidRealMoneyTransfer(db, { id: ID, routedVia: 'railp' });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect(fetchFn).not.toHaveBeenCalled();
    expectDeferred(await rowState());
    expect(await alerts()).toEqual([{ k: `fundmode:${ID}`, m: fundmodeText(ID, 'acme', 'railp', 'partner_collected', 'none') }]);
  });

  it('a b2b ach_pull row passes with no record', async () => {
    await certifyPartnerForTest(db, 'acme', { fundingMode: null });
    await paidRealMoneyTransfer(db, { id: ID, fundingMethod: 'ach_pull' });
    await db.execute(sql`UPDATE transfers SET transfer_type = 'b2b' WHERE id = ${ID}`);
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expectPosted();
    expect((await rowState()).status).toBe('done');
    expect((await alertKeys()).filter((k) => k.startsWith('fundmode:') || k.startsWith('mockfund:'))).toEqual([]);
  });

  it('the owner read throws (after the live gate): charged retry (failed, attempts 1), no alert', async () => {
    await certifyPartnerForTest(db, 'acme');
    await paidRealMoneyTransfer(db, { id: ID });
    await enqueueInstruct();
    partnerSeam.calls = 0;
    partnerSeam.failFrom = 2;
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await alertKeys()).toEqual([]);
  });

  it('a simulator rail with a mock-funded row: POSTed as today (demo unchanged)', async () => {
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {},
      payment: { providerType: 'simulator', credentials: { signingSecret: 'sgn' }, webhookSecret: 'whk' },
      whatsapp: {},
    });
    await paidRealMoneyTransfer(db, { id: ID, fundingProvider: 'mock', fundingRef: `mockfund-${ID}` });
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe(`${env.appBaseUrl}/api/partner-rail`);
    expect(await alertKeys()).toEqual([]);
  });
});
