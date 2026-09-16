import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer, CorridorRequest } from '@/lib/types';
import { easternDate } from '@/lib/dates';

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

function seedTransfer(status: Transfer['status'] = 'awaiting_payment'): Transfer {
  return {
    id: 'wh_1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    status, complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-05-29T00:00:00.000Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

function sampleTransfer(id: string, createdAt: string, phone = '15551234567'): Transfer {
  return {
    id,
    phone,
    amountUsd: 500,
    feeUsd: 0,
    totalChargeUsd: 500,
    fxRate: 85,
    amountInr: 42500,
    recipientName: 'Mom',
    recipientPhone: '919133001840',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt,
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 500,
    feeSource: 0,
    totalChargeSource: 500,
  };
}

describe('store transfers index', () => {
  it('listTransfers returns saved transfers newest-first', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('b', '2026-05-21T03:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('c', '2026-05-21T02:00:00.000Z'));
    const ids = (await store.listTransfers()).map((t) => t.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('re-saving a transfer does not duplicate it in the index', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    expect(await store.listTransfers()).toHaveLength(1);
  });
});

describe('store transfer count (derived from non-blocked rows)', () => {
  it('defaults to 0 and counts each saved transfer row', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.getTransferCount('default', 'p')).toBe(0);
    await store.saveTransfer(sampleTransfer('t1', '2026-05-21T01:00:00.000Z', 'p'));
    await store.saveTransfer(sampleTransfer('t2', '2026-05-21T02:00:00.000Z', 'p'));
    expect(await store.getTransferCount('default', 'p')).toBe(2);
  });

  it('excludes blocked transfers from the count', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('ok1', '2026-05-21T01:00:00.000Z', 'p'));
    await store.saveTransfer({
      ...sampleTransfer('bad1', '2026-05-21T02:00:00.000Z', 'p'),
      status: 'blocked',
    });
    expect(await store.getTransferCount('default', 'p')).toBe(1);
  });

  it('counts are isolated per phone', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('t1', '2026-05-21T01:00:00.000Z', 'p1'));
    expect(await store.getTransferCount('default', 'p1')).toBe(1);
    expect(await store.getTransferCount('default', 'p2')).toBe(0);
  });
});

describe('firstTransferAt (tenant-scoped)', () => {
  it('returns null when the phone has no transfers under this tenant', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.firstTransferAt('default', 'p')).toBeNull();
  });

  it('returns the earliest createdAt for (partner, phone) — another tenant\'s rows do not grandfather', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('t2', '2026-05-21T02:00:00.000Z', 'p'));
    await store.saveTransfer(sampleTransfer('t1', '2026-05-21T01:00:00.000Z', 'p'));
    expect(await store.firstTransferAt('default', 'p')).toBe('2026-05-21T01:00:00.000Z');
    expect(await store.firstTransferAt('acme', 'p')).toBeNull();
    expect(await store.getTransferCount('default', 'p')).toBe(2);
    expect(await store.getTransferCount('acme', 'p')).toBe(0);
    expect((await store.listTransfersByPhone('default', 'p')).map((t) => t.id)).toEqual(['t2', 't1']);
    expect(await store.listTransfersByPhone('acme', 'p')).toEqual([]);
  });
});

describe('store velocity counter (tenant-scoped)', () => {
  it('defaults today count to 0 and increments', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.getTodayTransferCount('default', 'p')).toBe(0);
    await store.incrementTodayTransferCount('default', 'p');
    await store.incrementTodayTransferCount('default', 'p');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(2);
  });

  it('velocity is isolated per (partner, phone) — a partner-API mint never inflates another tenant\'s counter', async () => {
    const store = createStore(fakeRedis(), db);
    await store.incrementTodayTransferCount('default', 'p1');
    expect(await store.getTodayTransferCount('default', 'p1')).toBe(1);
    expect(await store.getTodayTransferCount('acme', 'p1')).toBe(0);
    expect(await store.getTodayTransferCount('default', 'p2')).toBe(0);
  });

  it('uses velocity:{partnerId}:{phone}:{easternDate}', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.incrementTodayTransferCount('default', 'p');
    expect(redis.dump.has(`velocity:default:p:${easternDate(Date.now())}`)).toBe(true);
  });

  it('TRANSITIONAL: reads fall back to the legacy phone-only key for one window — ONLY for the phone\'s pre-fix (oldest-row) tenant; the first increment absorbs it', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    // Pre-fix state: the phone has exactly ONE customer row, under default.
    await createCustomerStore(db, store).upsertOnFirstInbound('default', 'p');
    await redis.set(`velocity:p:${easternDate(Date.now())}`, '3');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(3);
    await store.incrementTodayTransferCount('default', 'p');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(4);
  });

  it('TRANSITIONAL: a post-fix sibling tenant NEVER reads the legacy key (D3 — no cross-tenant compliance oracle)', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    const redis = fakeRedis();
    const store = createStore(redis, db);
    const cs = createCustomerStore(db, store);
    // The pre-fix owner is seeded with an EXPLICIT createdAt one minute in the past: two
    // upsertOnFirstInbound calls can land in the same millisecond, and findByPhone's
    // asc(partnerId) tie-break would then make 'acme' the "oldest" row (flake).
    const T0 = new Date(Date.now() - 60_000).toISOString();
    await cs.saveCustomer({ senderPhone: 'p', firstSeenAt: T0, kycStatus: 'not_started', senderCountry: 'US', partnerId: 'default', optInAt: T0, createdAt: T0, updatedAt: T0 }); // pre-fix owner
    await cs.upsertOnFirstInbound('acme', 'p');    // post-fix sibling (createdAt = now, strictly later)
    await redis.set(`velocity:p:${easternDate(Date.now())}`, '3');
    expect(await store.getTodayTransferCount('default', 'p')).toBe(3);
    expect(await store.getTodayTransferCount('acme', 'p')).toBe(0);
    // No customer row at all ⇒ no legacy read either (fail closed).
    await redis.set(`velocity:q:${easternDate(Date.now())}`, '9');
    expect(await store.getTodayTransferCount('default', 'q')).toBe(0);
  });
});

describe('updateTransferFromWebhook (idempotent, forward-only)', () => {
  it('advances awaiting_payment → paid and sets paidAt', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(seedTransfer());
    const r = await store.updateTransferFromWebhook('wh_1', 'paid');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('paid');
    expect(r!.paidAt).toBeTruthy();
  });

  it('advances paid → delivered and sets deliveredAt (keeps paidAt)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(seedTransfer('paid'));
    const r = await store.updateTransferFromWebhook('wh_1', 'delivered');
    expect(r!.status).toBe('delivered');
    expect(r!.deliveredAt).toBeTruthy();
  });

  it('is IDEMPOTENT: a duplicate paid_out (delivered) callback returns null, no re-save', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(seedTransfer('delivered'));
    expect(await store.updateTransferFromWebhook('wh_1', 'delivered')).toBeNull();
  });

  it('is FORWARD-ONLY: a backward funded (paid) after delivered is ignored', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(seedTransfer('delivered'));
    expect(await store.updateTransferFromWebhook('wh_1', 'paid')).toBeNull();
    expect((await store.getTransfer('wh_1'))!.status).toBe('delivered'); // never regressed
  });

  it('no-ops on an unknown transferId (untrusted body)', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.updateTransferFromWebhook('nope', 'paid')).toBeNull();
  });

  it('refuses to advance a cancelled transfer (terminal-protected)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(seedTransfer('cancelled'));
    expect(await store.updateTransferFromWebhook('wh_1', 'delivered')).toBeNull();
    expect((await store.getTransfer('wh_1'))!.status).toBe('cancelled');
  });

  it('refuses to advance a blocked transfer (terminal-protected)', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(seedTransfer('blocked'));
    expect(await store.updateTransferFromWebhook('wh_1', 'paid')).toBeNull();
  });

  it('returns the updated Transfer only on a real transition', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(seedTransfer());
    expect((await store.updateTransferFromWebhook('wh_1', 'paid'))!.id).toBe('wh_1'); // real
    expect(await store.updateTransferFromWebhook('wh_1', 'paid')).toBeNull();          // dup → null
  });
});

describe('store', () => {
  it('round-trips a transfer', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('abc12345', '2026-05-21T00:00:00.000Z'));
    const loaded = await store.getTransfer('abc12345');
    expect(loaded?.recipientName).toBe('Mom');
  });

  it('returns null for an unknown transfer', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.getTransfer('missing')).toBeNull();
  });

  it('round-trips conversation history', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveConversation('default', '15551234567', [
      { role: 'user', content: 'hi' },
    ]);
    const conv = await store.getConversation('default', '15551234567');
    expect(conv).toHaveLength(1);
    expect(conv[0].content).toBe('hi');
  });

  it('marks a message seen only once', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.markMessageSeen('wamid.1')).toBe(true);
    expect(await store.markMessageSeen('wamid.1')).toBe(false);
  });

  it('trims conversation history to the last 40 messages', async () => {
    const store = createStore(fakeRedis(), db);
    const many = Array.from({ length: 60 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    await store.saveConversation('default', 'p', many);
    const conv = await store.getConversation('default', 'p');
    expect(conv).toHaveLength(40);
    expect(conv[conv.length - 1].content).toBe('m59');
  });

  it('conv is keyed (partnerId, phone) and a sibling tenant starts empty (fix 1, D12)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.saveConversation('default', 'p', [{ role: 'user', content: 'hi' }]);
    expect(redis.dump.has('conv:default:p')).toBe(true);
    expect(redis.dump.has('conv:p')).toBe(false);
    expect(await store.getConversation('acme', 'p')).toEqual([]);
    await store.recordInboundNow('default', 'p');
    expect(redis.dump.has('lastmsg:default:p')).toBe(true);
    expect(await store.getLastInboundAt('acme', 'p')).toBeNull();
  });
});

describe('saveCorridorRequest + listCorridorRequests', () => {
  function makeReq(id: string, capturedAt: string, country: string): CorridorRequest {
    return { id, senderPhone: '15551234567', destinationCountry: country, capturedAt };
  }

  it('round-trips a single corridor request', async () => {
    const store = createStore(fakeRedis(), db);
    const req = makeReq('req1', '2026-05-30T10:00:00.000Z', 'UAE');
    await store.saveCorridorRequest(req);
    const list = await store.listCorridorRequests();
    expect(list).toHaveLength(1);
    expect(list[0].destinationCountry).toBe('UAE');
    expect(list[0].senderPhone).toBe('15551234567');
  });

  it('listCorridorRequests returns newest-first', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveCorridorRequest(makeReq('older', '2026-05-29T08:00:00.000Z', 'Pakistan'));
    await store.saveCorridorRequest(makeReq('newer', '2026-05-30T12:00:00.000Z', 'UAE'));
    const list = await store.listCorridorRequests();
    expect(list[0].id).toBe('newer');
    expect(list[1].id).toBe('older');
  });

  it('saving the same id twice does not duplicate the entry', async () => {
    const store = createStore(fakeRedis(), db);
    const req = makeReq('dup1', '2026-05-30T10:00:00.000Z', 'UAE');
    await store.saveCorridorRequest(req);
    // Postgres PK on id: a duplicate insert is REJECTED (append-only capture),
    // replacing the old Redis last-write-wins SET semantics.
    await expect(
      store.saveCorridorRequest({ ...req, destinationCountry: 'UAE updated' }),
    ).rejects.toThrow();
    const list = await store.listCorridorRequests();
    expect(list).toHaveLength(1);
    expect(list[0].destinationCountry).toBe('UAE'); // original row untouched
  });
});
