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

import { DELIVERY_LOG_TIMEOUT_MS, recordInstructDelivery, withInstructDeliveryLog } from '@/lib/webhook-delivery-log';

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
