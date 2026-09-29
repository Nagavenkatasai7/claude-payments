import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { partnerWebhookDeliveries } from '@/db/schema';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// UI redesign M3-15b: the settlement.instruct branch writes ONE partner_webhook_deliveries row per
// POST attempt, for the RAIL OWNER, and that write can never change the money outcome: the outbox
// row is done / failed / backed off exactly as without the log, the POST count is unchanged and
// providerRef is written the same, even when the delivery insert throws. Rows are written only when a
// POST was made: the pre-POST exits (not payable, sandbox, refused URL) record nothing.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));

function transferFixture(): Transfer {
  return {
    id: 'dl_t1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(), paidAt: new Date(Date.now() - 3_000_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

let db: Db;
let store: ReturnType<typeof createStore>;
let outbox: ReturnType<typeof createOutboxRepo>;
const fetchFn = vi.fn();

function deps(overrideDb?: Db): WorkerDeps {
  return {
    db: overrideDb ?? db,
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

/** The real db, except that every insert into partner_webhook_deliveries throws. */
function failingLogDb(): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          if (table === partnerWebhookDeliveries) throw new Error('delivery log down');
          return target.insert(table as never);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const rail = (url: string, secret: string) => ({
  kyc: {},
  payment: { providerType: 'http' as const, credentials: { settlementUrl: url, signingSecret: secret }, webhookSecret: 'whk' },
  whatsapp: {},
});

const deliveries = () => db.select().from(partnerWebhookDeliveries).orderBy(partnerWebhookDeliveries.id);
type RowState = { status: string; attempts: number; last_error: string | null; backoff_s: number };
async function rowState(): Promise<RowState> {
  const r = (await db.execute(sql`
    SELECT status, attempts, last_error,
           round(extract(epoch FROM (next_attempt_at - now())))::int AS backoff_s
    FROM outbox WHERE kind = 'settlement.instruct'`)) as unknown as { rows: RowState[] };
  return r.rows[0];
}
const providerRef = async () => (await store.getTransfer('dl_t1'))!.paymentProviderRef ?? null;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  outbox = createOutboxRepo(db);
  await seedPartner(db, 'acme');
  fetchFn.mockReset();
  await store.saveTransfer(transferFixture());
  await createIntegrationsRepo(db, provider).saveIntegrations('acme', rail('https://rail.example/settle', 'sgn'));
});

describe('settlement.instruct → partner_webhook_deliveries', { retry: 0 }, () => {
  it('a 200 instruct writes ONE ok row for the rail owner: transfer id, outbox id, attempt 1, status, latency; no URL or body', async () => {
    fetchFn.mockResolvedValue(new Response(JSON.stringify({ providerRef: 'rail-1' }), { status: 200 }));
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'instruct:dl_t1' });
    const [{ id }] = (await db.execute(sql`SELECT id FROM outbox WHERE dedupe_key = 'instruct:dl_t1'`) as unknown as { rows: Array<{ id: number }> }).rows;

    const r = await drainOnce(deps(), 'w1');
    expect(r.processed).toBe(1);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'acme', kind: 'settlement.instruct', subjectId: 'dl_t1', outboxId: Number(id), attempt: 1, outcome: 'ok', httpStatus: 200 });
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(0);
    const text = JSON.stringify(rows);
    for (const leak of ['rail.example', '123456789012', 'Anita', '919876543210', 'sgn']) expect(text).not.toContain(leak);
    expect(await providerRef()).toBe('rail-1');
  });

  it('a ROUTED transfer records the row for the SETTLEMENT partner (the rail whose endpoint was called), not the owner', async () => {
    await seedPartner(db, 'railp');
    await store.saveTransfer({ ...transferFixture(), settlementPartnerId: 'railp' });
    await createIntegrationsRepo(db, provider).saveIntegrations('railp', rail('https://railp.example/settle', 'rsgn'));
    fetchFn.mockResolvedValue(new Response('{}', { status: 200 }));
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'instruct:dl_t1' });
    await drainOnce(deps(), 'w1');
    expect((fetchFn.mock.calls[0] as [string])[0]).toBe('https://railp.example/settle');
    expect((await deliveries()).map((d) => [d.partnerId, d.outcome])).toEqual([['railp', 'ok']]);
  });

  it('a 500 writes ONE http_error row with the status; the outbox row fails and backs off exactly as before', async () => {
    fetchFn.mockResolvedValue(new Response('down', { status: 500 }));
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'instruct:dl_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(1);
    expect((await deliveries()).map((d) => [d.outcome, d.httpStatus, d.attempt])).toEqual([['http_error', 500, 1]]);
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Settlement instruction rejected (500)' });
    // The next attempt is recorded as attempt 2.
    await db.execute(sql`UPDATE outbox SET next_attempt_at = now() WHERE kind = 'settlement.instruct'`);
    await drainOnce(deps(), 'w1');
    expect((await deliveries()).map((d) => d.attempt)).toEqual([1, 2]);
  });

  it('a thrown POST (timeout / network) writes ONE network row with no status; the row fails as before', async () => {
    fetchFn.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'instruct:dl_t1' });
    const r = await drainOnce(deps(), 'w1');
    expect(r.failed).toBe(1);
    expect((await deliveries()).map((d) => [d.outcome, d.httpStatus])).toEqual([['network', null]]);
    expect(await rowState()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'The operation was aborted due to timeout' });
  });

  describe.each([
    { name: '200', res: () => new Response(JSON.stringify({ providerRef: 'rail-9' }), { status: 200 }) },
    { name: '500', res: () => new Response('down', { status: 500 }) },
  ])('a THROWING delivery insert leaves the money outcome identical ($name)', ({ res }) => {
    async function run(withFailingLog: boolean) {
      db = await freshDb();
      store = createStore(fakeRedis(), db);
      outbox = createOutboxRepo(db);
      await seedPartner(db, 'acme');
      await store.saveTransfer(transferFixture());
      await createIntegrationsRepo(db, provider).saveIntegrations('acme', rail('https://rail.example/settle', 'sgn'));
      fetchFn.mockReset();
      fetchFn.mockImplementation(async () => res());
      await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'instruct:dl_t1' });
      const result = await drainOnce(deps(withFailingLog ? failingLogDb() : undefined), 'w1');
      return {
        result,
        row: await rowState(),
        posts: fetchFn.mock.calls.length,
        providerRef: await providerRef(),
        logged: (await deliveries()).length,
      };
    }

    it('same drain result, outbox row (status, attempts, last_error, backoff), POST count and providerRef', async () => {
      const normal = await run(false);
      const broken = await run(true);
      expect(normal.logged).toBe(1);
      expect(broken.logged).toBe(0);
      expect(broken.result).toEqual(normal.result);
      expect(broken.row).toEqual(normal.row);
      expect(broken.posts).toBe(1);
      expect(normal.posts).toBe(1);
      expect(broken.providerRef).toBe(normal.providerRef);
    });
  });

  it('a SLOW delivery insert never costs the rail providerRef: the body is read before the record is awaited', async () => {
    const slowLogDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) =>
            table === partnerWebhookDeliveries
              ? { values: (v: unknown) => new Promise((r) => setTimeout(() => r(target.insert(partnerWebhookDeliveries).values(v as never)), 400)) }
              : target.insert(table as never);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    let answeredAt = 0;
    // Stands in for a body whose read is aborted by the still-armed AbortSignal.timeout if it is delayed.
    fetchFn.mockImplementation(async () => {
      answeredAt = Date.now();
      return { ok: true, status: 200, json: async () => {
        if (Date.now() - answeredAt > 150) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
        return { providerRef: 'rail-fast' };
      } };
    });
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'instruct:dl_t1' });
    const r = await drainOnce(deps(slowLogDb), 'w1');
    expect(r.processed).toBe(1);
    expect(await providerRef()).toBe('rail-fast');
    expect((await deliveries()).map((d) => d.outcome)).toEqual(['ok']); // awaited before the handler returned
  });

  it('pre-POST exits record NOTHING: a delivered transfer, a sandbox transfer, a refused stored URL', async () => {
    await store.saveTransfer({ ...transferFixture(), status: 'delivered' });
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'instruct:dl_t1' });
    await drainOnce(deps(), 'w1');

    await store.saveTransfer(transferFixture());
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = 'dl_t1'`);
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'reinstruct:dl_t1' });
    await drainOnce(deps(), 'w1');

    await db.execute(sql`UPDATE transfers SET environment = 'live' WHERE id = 'dl_t1'`);
    await createIntegrationsRepo(db, provider).saveIntegrations('acme', rail('http://10.0.0.5/settle', 'sgn'));
    await outbox.enqueue('settlement.instruct', { transferId: 'dl_t1' }, { dedupeKey: 'third:dl_t1' });
    await drainOnce(deps(), 'w1');

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await deliveries()).toHaveLength(0);
  });
});
