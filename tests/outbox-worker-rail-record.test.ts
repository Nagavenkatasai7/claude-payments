import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest, seedOriginatorForTest } from './helpers-live';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { partnerWebhookDeliveries, railMessages } from '@/db/schema';
import { railBodySha256 } from '@/db/repos/rail-message-repo';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { railRecordAlertKey } from '@/lib/instruct-errors';
import { invalidateFlagCache } from '@/lib/flags';
import { ctx } from '@/lib/crypto-context';
import { decryptField, defaultProvider, EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T9 (P4, P7, P8 G17/G18): no instruction leaves without its record.
// settlement.instruct and the partner-pulled reverse build the body and the
// signed headers ONCE, append the sealed rail_messages row (direction 1) and
// AWAIT it, and only then POST those same bytes and headers. A failed append is
// a RailRecordError: no POST, no railfail, one railrecord:<hour> alert.

const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return { ...real, logWarn: (...a: Parameters<typeof real.logWarn>) => { logWarnSpy(...a); return real.logWarn(...a); } };
});

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const ID = 'dl_t1';

function transferFixture(): Transfer {
  return {
    id: ID, phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

const pulledFixture = (): Transfer =>
  ({
    ...transferFixture(),
    fundingMethod: 'ach_pull',
    transferType: 'b2b',
    achTokenRef: 'ach_deadbeef',
    senderBusinessName: 'Raj Trading Co',
    recipientBusinessName: 'Wilson HK Ltd',
    refundStatus: 'pending',
  }) as Transfer;

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();
/** When true, every insert into rail_messages throws (a NeonDbError, as a dropped connection). */
let recordDown = false;
/** rail_messages rows seen at the moment of each fetch call. */
let rowsAtFetch: number[] = [];

/**
 * The real db, except that an insert into rail_messages throws while `recordDown`.
 * Truth check F10 (F1): the settle record is written inside a transaction (the
 * re-check under the row lock), so a transaction handle is wrapped the same way.
 */
function recordingDb(target: object = db): Db {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          if (table === railMessages && recordDown) throw Object.assign(new Error('x'), { name: 'NeonDbError' });
          return (t as Db).insert(table as never);
        };
      }
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
          (t as unknown as { transaction: (f: (tx: object) => unknown, ...r: unknown[]) => unknown }).transaction((tx) => fn(recordingDb(tx)), ...rest);
      }
      const v = Reflect.get(t, prop, receiver);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Db;
}

function deps(): WorkerDeps {
  return {
    db: recordingDb(),
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

const rail = (url: string, secret: string) => ({
  kyc: {},
  payment: { providerType: 'http' as const, credentials: { settlementUrl: url, signingSecret: secret }, webhookSecret: 'whk' },
  whatsapp: {},
});

type RecRow = {
  id: string; partner_id: string | null; rail_partner_id: string | null; transfer_id: string | null;
  direction: number; kind: string; body_enc: string; body_sha256: string; signature_header: string | null;
};
async function records(): Promise<RecRow[]> {
  return ((await db.execute(sql`SELECT * FROM rail_messages ORDER BY created_at, id`)) as unknown as { rows: RecRow[] }).rows;
}
async function countRecords(): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM rail_messages`)) as unknown as { rows: Array<{ n: number }> };
  return Number(r.rows[0].n);
}
const deliveries = () => db.select().from(partnerWebhookDeliveries).orderBy(partnerWebhookDeliveries.id);
type RowState = { status: string; attempts: number; last_error: string | null };
async function rowState(kind: string): Promise<RowState> {
  const r = (await db.execute(sql`SELECT status, attempts, last_error FROM outbox WHERE kind = ${kind}`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}
async function alerts(): Promise<Array<{ k: string; message: string }>> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k, payload->>'message' AS message FROM outbox WHERE kind = 'ops.alert' ORDER BY id`)) as unknown as {
    rows: Array<{ k: string; message: string }>;
  };
  return r.rows;
}
const open = (r: RecRow) => decryptField(r.body_enc, defaultProvider(), ctx.railMessage(r.id, 1, r.kind as 'settle' | 'reverse'));
const ok200 = () => new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 });
const enqueueInstruct = (key = `instruct:${ID}`) => outbox.enqueue('settlement.instruct', { transferId: ID }, { dedupeKey: key });

beforeEach(async () => {
  recordDown = false;
  rowsAtFetch = [];
  logWarnSpy.mockClear();
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  await certifyPartnerForTest(db, 'acme');
  // Fix pack 5 T20a (P0 rule 9): the sender's travel-rule data on file, ahead of the T20b/T23 gates.
  await seedOriginatorForTest(db, 'acme', '15551230000', { address: true, dob: true });
  fetchFn.mockReset();
  fetchFn.mockImplementation(async () => {
    rowsAtFetch.push(await countRecords());
    return ok200();
  });
  await store.saveTransfer(transferFixture());
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', rail('https://rail.example/settle', 'sgn'));
});
afterEach(() => invalidateFlagCache(db));

describe('settlement.instruct records the settle message before the POST (G17, G18)', { retry: 0 }, () => {
  // Review round 2 GF1: Date frozen (after the top-level freshDb()) so the
  // worker's railrecord:<hour> and the expected key read the same instant.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('the settle row exists BEFORE the POST with the exact bytes, hash and header that were POSTed', async () => {
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(rowsAtFetch).toEqual([1]);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    const [r] = await records();
    expect(r).toMatchObject({ partner_id: 'acme', rail_partner_id: 'acme', transfer_id: ID, kind: 'settle' });
    expect(Number(r.direction)).toBe(1);
    expect(open(r)).toBe(init.body);
    expect(r.body_sha256).toBe(railBodySha256(String(init.body)));
    expect(r.signature_header).toBe(init.headers['x-smartremit-signature']);
    expect(init.headers['x-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body_enc).not.toContain('Anita');
    expect((await store.getTransfer(ID))!.paymentProviderRef).toBe('rail-1');
  });

  it('a routed row: partner_id is the owner, rail_partner_id the settlement partner', async () => {
    await seedPartner(db, 'railp');
    await certifyPartnerForTest(db, 'railp');
    await store.saveTransfer({ ...transferFixture(), settlementPartnerId: 'railp' });
    // Fix pack 5 T23 (P22, owner Q1): a non-exempt routed real-money row waits
    // on the travel rule; a Partner-API-minted (exempt) routed row is sent.
    await createIdempotencyRepo(db).claim('acme', 'order-dl_t1', 'dl_t1');
    await createIntegrationsRepo(db, provider).saveIntegrations('railp', rail('https://railp.example/settle', 'rsgn'));
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe('https://railp.example/settle');
    const [r] = await records();
    expect(r).toMatchObject({ partner_id: 'acme', rail_partner_id: 'railp', kind: 'settle' });
  });

  it('the delivery-log row carries the same body_sha256', async () => {
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    const [r] = await records();
    const d = await deliveries();
    expect(d).toHaveLength(1);
    expect(d[0].bodySha256).toBe(r.body_sha256);
  });

  it('a failed append: NO fetch, no delivery row, no railfail; charged and failed; ONE railrecord:<hour> alert', async () => {
    recordDown = true;
    await enqueueInstruct();
    // Attempt 3 is where a RailInstructError would raise railfail: (the record failure must not).
    await db.execute(sql`UPDATE outbox SET attempts = 2 WHERE kind = 'settlement.instruct'`);
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await deliveries()).toHaveLength(0);
    expect(await countRecords()).toBe(0);
    const st = await rowState('settlement.instruct');
    expect(st).toMatchObject({ status: 'failed', attempts: 3 });
    expect(st.last_error).toBe(`rail_record_failed:${ID}`);
    expect(st.last_error).not.toContain('123456789012');
    const a = await alerts();
    expect(a.map((x) => x.k)).toContain(railRecordAlertKey());
    expect(a.some((x) => x.k.startsWith('railfail:'))).toBe(false);
    const rec = a.filter((x) => x.k === railRecordAlertKey());
    expect(rec).toHaveLength(1);
    expect(rec[0].message).toContain(`transfer ${ID}`);
    expect(rec[0].message).toContain('settlement.instruct');
    const t = (await store.getTransfer(ID))!;
    expect(t.status).toBe('paid');
    expect(t.paymentProviderRef ?? null).toBeNull();
    // The log names the error and the ids only, never the body (test 11).
    expect(logWarnSpy).toHaveBeenCalledWith('outbox.rail-record', 'NeonDbError', { transferId: ID, kind: 'settle' });
    const logged = JSON.stringify(logWarnSpy.mock.calls);
    for (const leak of ['123456789012', 'Anita']) expect(logged).not.toContain(leak);
  });

  it('a second failure in the same hour adds no second railrecord alert', async () => {
    recordDown = true;
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
    await drainOnce(deps(), 'w1');
    expect((await rowState('settlement.instruct')).attempts).toBe(2);
    expect((await alerts()).filter((x) => x.k === railRecordAlertKey())).toHaveLength(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('the next attempt, store back, records and POSTs', async () => {
    recordDown = true;
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    recordDown = false;
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
    await drainOnce(deps(), 'w1'); // also drains the railrecord ops.alert of the first attempt
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(rowsAtFetch).toEqual([1]);
    expect((await rowState('settlement.instruct')).status).toBe('done');
    expect((await store.getTransfer(ID))!.paymentProviderRef).toBe('rail-1');
  });

  it('each POSTed attempt adds its own row', async () => {
    fetchFn.mockReset();
    fetchFn.mockResolvedValueOnce(new Response('down', { status: 500 })).mockResolvedValueOnce(ok200());
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
    await drainOnce(deps(), 'w1');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const rs = await records();
    expect(rs).toHaveLength(2);
    expect(rs[0].id).not.toBe(rs[1].id);
    expect(rs[0].body_sha256).toBe(rs[1].body_sha256);
    expect(rs.map((r) => r.kind)).toEqual(['settle', 'settle']);
    expect((await deliveries()).map((d) => d.bodySha256)).toEqual([rs[0].body_sha256, rs[0].body_sha256]);
  });

  it('pre-POST exits record nothing: delivered, sandbox, refused URL, settlement.paused', async () => {
    await store.saveTransfer({ ...transferFixture(), status: 'delivered' });
    await enqueueInstruct();
    await drainOnce(deps(), 'w1');

    await store.saveTransfer(transferFixture());
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${ID}`);
    await enqueueInstruct('reinstruct:dl_t1');
    await drainOnce(deps(), 'w1');

    await db.execute(sql`UPDATE transfers SET environment = 'live' WHERE id = ${ID}`);
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', rail('http://10.0.0.5/settle', 'sgn'));
    await enqueueInstruct('third:dl_t1');
    await drainOnce(deps(), 'w1');

    await createIntegrationsRepo(db, provider).saveIntegrations('acme', rail('https://rail.example/settle', 'sgn'));
    await createFeatureFlagRepo(db).upsert({ key: 'settlement.paused', scopeType: 'global', scopeId: '', enabled: true, reason: 'rail incident', updatedBy: 'admin' });
    invalidateFlagCache(db);
    await enqueueInstruct('fourth:dl_t1');
    await drainOnce(deps(), 'w1');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await countRecords()).toBe(0);
    expect(await deliveries()).toHaveLength(0);
  });
});

// Review round 2 GF1: the railrecord:<hour> key is read from the clock by the
// worker; a test that reads it AGAIN after the drain goes red when the run
// crosses an hour boundary. This case pins the clock to the last millisecond of
// an hour (in the past, so the row is due against Postgres now()), drains, and
// moves into the next hour before it asserts.
describe('railrecord:<hour> across an hour boundary (review round 2 GF1)', { retry: 0 }, () => {
  afterEach(() => vi.useRealTimers());

  it('the alert carries the key of the hour the drain ran in, read once from the pinned clock', async () => {
    const H = 3_600_000;
    const hourStart = Math.floor(Date.now() / H) * H;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(hourStart - 1); // HH:59:59.999 of the previous hour
    const expected = railRecordAlertKey(); // read ONCE, before the action
    recordDown = true;
    await enqueueInstruct();
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    vi.setSystemTime(hourStart); // the next hour
    expect((await alerts()).map((x) => x.k)).toEqual([expected]);
    expect(expected).toBe(railRecordAlertKey(hourStart - 1));
  });
});

describe('funding.refund partner-pulled reverse records before its POST', { retry: 0 }, () => {
  // Review round 2 GF1: Date frozen (after the top-level freshDb()) so the
  // worker's railrecord:<hour> and the expected key read the same instant.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it("a partner-pulled reverse is recorded (kind 'reverse') before its POST with the exact bytes and header", async () => {
    await store.saveTransfer(pulledFixture());
    fetchFn.mockImplementation(async () => {
      rowsAtFetch.push(await countRecords());
      return new Response(JSON.stringify({ providerRef: 'reverse-rail-9' }), { status: 200 });
    });
    await outbox.enqueue('funding.refund', { transferId: ID }, { dedupeKey: `refund:${ID}` });
    expect((await drainOnce(deps(), 'w1')).processed).toBe(1);
    expect(rowsAtFetch).toEqual([1]);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(JSON.parse(String(init.body))).toMatchObject({ action: 'reverse', reference: `reverse-${ID}` });
    const [r] = await records();
    expect(r).toMatchObject({ partner_id: 'acme', rail_partner_id: 'acme', transfer_id: ID, kind: 'reverse' });
    expect(Number(r.direction)).toBe(1);
    expect(open(r)).toBe(init.body);
    expect(r.body_sha256).toBe(railBodySha256(String(init.body)));
    expect(r.signature_header).toBe(init.headers['x-smartremit-signature']);
    expect((await store.getTransfer(ID))!.refundStatus).toBe('completed');
  });

  it('a failed reverse record: no POST, refund stays pending, the funding.refund row fails (default policy), ONE railrecord:<hour> alert', async () => {
    await store.saveTransfer(pulledFixture());
    recordDown = true;
    await outbox.enqueue('funding.refund', { transferId: ID }, { dedupeKey: `refund:${ID}` });
    expect((await drainOnce(deps(), 'w1')).failed).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await countRecords()).toBe(0);
    expect(await rowState('funding.refund')).toMatchObject({ status: 'failed', attempts: 1, last_error: `rail_record_failed:${ID}` });
    expect((await store.getTransfer(ID))!.refundStatus).toBe('pending');
    const rec = (await alerts()).filter((x) => x.k === railRecordAlertKey());
    expect(rec).toHaveLength(1);
    expect(rec[0].message).toContain('funding.refund');
    expect((await alerts()).some((x) => x.k.startsWith('railfail:'))).toBe(false);
    expect(logWarnSpy).toHaveBeenCalledWith('outbox.rail-record', 'NeonDbError', { transferId: ID, kind: 'reverse' });
  });
});
