import { describe, it, expect, vi, beforeEach } from 'vitest';
import { freshDb, seedPartner } from './helpers-db';
import { partnerWebhookDeliveries } from '@/db/schema';
import type { Db } from '@/db/client';

// UI redesign M3-15b: the worker-side delivery recorder. It is best-effort by contract: it never
// throws, it is bounded in time (a stalled insert must never push a settlement.instruct row past its
// deadline, which would make it retryable and re-POST money), and it stores no URL, body, secret or
// error text: only ids, the outcome class, the HTTP status integer, latency and the attempt number.

const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));

import { DELIVERY_LOG_TIMEOUT_MS, DELIVERY_PAGE_SIZE, listDeliveries, parseDeliveryCursor, recordInstructDelivery, withInstructDeliveryLog } from '@/lib/webhook-delivery-log';

let db: Db;
const meta = { partnerId: 'pa', transferId: 'tr_1', outboxId: 42, attempt: 3 };

beforeEach(async () => {
  logWarnSpy.mockClear();
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
});

const rows = () => db.select().from(partnerWebhookDeliveries);

/** A db whose insert into partner_webhook_deliveries behaves as `insert`; every other call is the real db. */
function stubDb(insert: () => unknown): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => (table === partnerWebhookDeliveries ? { values: () => insert() } : target.insert(table as never));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('recordInstructDelivery', () => {
  it('writes one settlement.instruct row with ids, outcome, status, latency and attempt only', async () => {
    await recordInstructDelivery(db, { ...meta, outcome: 'ok', httpStatus: 200, latencyMs: 12.7 });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ partnerId: 'pa', kind: 'settlement.instruct', subjectId: 'tr_1', outboxId: 42, attempt: 3, outcome: 'ok', httpStatus: 200, latencyMs: 13 });
    // The table has no URL / body / error column; the row carries nothing else.
    expect(Object.keys(r[0]).sort()).toEqual(['attempt', 'createdAt', 'httpStatus', 'id', 'kind', 'latencyMs', 'outboxId', 'outcome', 'partnerId', 'subjectId']);
  });

  it('a non-integer or out-of-range status is stored as null; a negative latency as 0', async () => {
    await recordInstructDelivery(db, { ...meta, outcome: 'http_error', httpStatus: undefined, latencyMs: -5 });
    await recordInstructDelivery(db, { ...meta, outcome: 'http_error', httpStatus: 99999, latencyMs: Number.NaN });
    const r = await rows();
    expect(r.map((x) => [x.httpStatus, x.latencyMs])).toEqual([[null, 0], [null, 0]]);
  });

  it('never throws when the insert fails; logs the error NAME only, with ids', async () => {
    const failing = stubDb(() => Promise.reject(Object.assign(new Error('violates check constraint; Failing row contains (pa, https://rail.example/x)'), { name: 'DatabaseError' })));
    await expect(recordInstructDelivery(failing, { ...meta, outcome: 'ok', httpStatus: 200, latencyMs: 1 })).resolves.toBeUndefined();
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    const [, message, fields] = logWarnSpy.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(message).toBe('DatabaseError');
    expect(fields).toEqual({ partnerId: 'pa', outboxId: 42 });
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toContain('rail.example');
  });

  it('never throws when the insert throws synchronously', async () => {
    const failing = stubDb(() => {
      throw new TypeError('boom');
    });
    await expect(recordInstructDelivery(failing, { ...meta, outcome: 'ok', httpStatus: 200, latencyMs: 1 })).resolves.toBeUndefined();
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up after the time cap when the insert never settles (bounded, never hangs the money row)', async () => {
    const hanging = stubDb(() => new Promise(() => {}));
    const started = Date.now();
    await expect(recordInstructDelivery(hanging, { ...meta, outcome: 'ok', httpStatus: 200, latencyMs: 1 }, 25)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    expect((logWarnSpy.mock.calls[0] as unknown[])[1]).toBe('DeliveryLogTimeout');
  });

  it('the default cap is small next to the row deadline and the rail timeout', async () => {
    const { ROW_DEADLINE_MS } = await import('@/lib/outbox-worker');
    const { RAIL_TIMEOUT_MS } = await import('@/lib/providers/http-payment-provider');
    expect(DELIVERY_LOG_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    expect(RAIL_TIMEOUT_MS + 2 * DELIVERY_LOG_TIMEOUT_MS).toBeLessThan(ROW_DEADLINE_MS);
  });
});

describe('withInstructDeliveryLog', () => {
  it('returns the response unchanged and records ok with its status', async () => {
    const res = new Response('{}', { status: 201 });
    await expect(withInstructDeliveryLog(db, meta, async () => res)).resolves.toBe(res);
    expect((await rows()).map((r) => [r.outcome, r.httpStatus])).toEqual([['ok', 201]]);
  });

  it('records http_error for a non-2xx and still returns the response (the caller decides)', async () => {
    const res = new Response(null, { status: 503 });
    await expect(withInstructDeliveryLog(db, meta, async () => res)).resolves.toBe(res);
    expect((await rows()).map((r) => [r.outcome, r.httpStatus])).toEqual([['http_error', 503]]);
  });

  it('records network and rethrows the SAME error when the POST throws', async () => {
    const err = new Error('The operation was aborted due to timeout');
    await expect(withInstructDeliveryLog(db, meta, async () => Promise.reject(err))).rejects.toBe(err);
    expect((await rows()).map((r) => [r.outcome, r.httpStatus])).toEqual([['network', null]]);
  });

  it('a failing recorder changes neither the returned response nor the thrown error', async () => {
    const failing = stubDb(() => Promise.reject(new Error('down')));
    const res = new Response(null, { status: 200 });
    await expect(withInstructDeliveryLog(failing, meta, async () => res)).resolves.toBe(res);
    const err = new Error('net');
    await expect(withInstructDeliveryLog(failing, meta, async () => Promise.reject(err))).rejects.toBe(err);
    expect(await rows()).toHaveLength(0);
  });

  it('a response-like object without a numeric status stores a null status', async () => {
    const res = { ok: true, json: async () => ({}) } as unknown as Response;
    await expect(withInstructDeliveryLog(db, meta, async () => res)).resolves.toBe(res);
    expect((await rows()).map((r) => [r.outcome, r.httpStatus])).toEqual([['ok', null]]);
  });
});

describe('listDeliveries (the /partner delivery log reader)', () => {
  async function seed(n: number, partnerId = 'pa') {
    for (let i = 0; i < n; i++) {
      await recordInstructDelivery(db, { partnerId, transferId: `tr_${partnerId}_${i}`, outboxId: 100 + i, attempt: 1, outcome: i % 2 ? 'http_error' : 'ok', httpStatus: i % 2 ? 500 : 200, latencyMs: i });
    }
  }

  it("the session tenant's rows only, newest first, both kinds, masked columns only (no outbox id, no URL)", async () => {
    await seedPartner(db, 'pb', 'Partner B');
    await seed(2, 'pa');
    await seed(1, 'pb');
    await db.insert(partnerWebhookDeliveries).values({ partnerId: 'pa', kind: 'ping', attempt: 1, outcome: 'ok', httpStatus: 204, latencyMs: 3 });
    const page = await listDeliveries(db, 'pa', {});
    expect(page.rows.map((r) => [r.kind, r.subjectId])).toEqual([['ping', null], ['settlement.instruct', 'tr_pa_1'], ['settlement.instruct', 'tr_pa_0']]);
    expect(Object.keys(page.rows[0]).sort()).toEqual(['attempt', 'createdAt', 'httpStatus', 'id', 'kind', 'latencyMs', 'outcome', 'subjectId']);
    expect(JSON.stringify(page.rows)).not.toContain('tr_pb_');
    expect(page.nextBefore).toBeNull();
  });

  it('keyset pages by id inside the tenant: 50 per page, then the older rows', async () => {
    await seed(53);
    const first = await listDeliveries(db, 'pa', {});
    expect(first.rows).toHaveLength(DELIVERY_PAGE_SIZE);
    expect(first.nextBefore).toBe(first.rows[DELIVERY_PAGE_SIZE - 1].id);
    const second = await listDeliveries(db, 'pa', { before: first.nextBefore });
    expect(second.rows.map((r) => r.subjectId)).toEqual(['tr_pa_2', 'tr_pa_1', 'tr_pa_0']);
    expect(second.nextBefore).toBeNull();
  });

  it("a cursor never reaches another tenant's rows", async () => {
    await seedPartner(db, 'pb', 'Partner B');
    await seed(3, 'pb');
    const page = await listDeliveries(db, 'pa', { before: 1_000_000 });
    expect(page.rows).toEqual([]);
  });
});

describe('parseDeliveryCursor', () => {
  it.each([
    ['17', 17],
    ['1', 1],
    [undefined, null],
    ['', null],
    ['0', null],
    ['-4', null],
    ['1e3', null],
    ['12abc', null],
    [' 12', null],
    ['9'.repeat(20), null],
    [['5', '6'], null],
  ] as Array<[unknown, number | null]>)('%j → %j', (v, want) => {
    expect(parseDeliveryCursor(v)).toBe(want);
  });
});
