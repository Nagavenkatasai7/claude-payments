import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '@/lib/store';
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
    expect(await store.getTransferCount('p')).toBe(0);
    await store.saveTransfer(sampleTransfer('t1', '2026-05-21T01:00:00.000Z', 'p'));
    await store.saveTransfer(sampleTransfer('t2', '2026-05-21T02:00:00.000Z', 'p'));
    expect(await store.getTransferCount('p')).toBe(2);
  });

  it('excludes blocked transfers from the count', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('ok1', '2026-05-21T01:00:00.000Z', 'p'));
    await store.saveTransfer({
      ...sampleTransfer('bad1', '2026-05-21T02:00:00.000Z', 'p'),
      status: 'blocked',
    });
    expect(await store.getTransferCount('p')).toBe(1);
  });

  it('counts are isolated per phone', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('t1', '2026-05-21T01:00:00.000Z', 'p1'));
    expect(await store.getTransferCount('p1')).toBe(1);
    expect(await store.getTransferCount('p2')).toBe(0);
  });
});

describe('firstTransferAt', () => {
  it('returns null when the phone has no transfers', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.firstTransferAt('p')).toBeNull();
  });

  it('returns the earliest createdAt for the phone', async () => {
    const store = createStore(fakeRedis(), db);
    await store.saveTransfer(sampleTransfer('t2', '2026-05-21T02:00:00.000Z', 'p'));
    await store.saveTransfer(sampleTransfer('t1', '2026-05-21T01:00:00.000Z', 'p'));
    expect(await store.firstTransferAt('p')).toBe('2026-05-21T01:00:00.000Z');
  });
});

describe('store velocity counter', () => {
  it('defaults today count to 0 and increments', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.getTodayTransferCount('p')).toBe(0);
    await store.incrementTodayTransferCount('p');
    await store.incrementTodayTransferCount('p');
    expect(await store.getTodayTransferCount('p')).toBe(2);
  });

  it('velocity is isolated per phone', async () => {
    const store = createStore(fakeRedis(), db);
    await store.incrementTodayTransferCount('p1');
    expect(await store.getTodayTransferCount('p1')).toBe(1);
    expect(await store.getTodayTransferCount('p2')).toBe(0);
  });

  it('uses an eastern-date-keyed velocity key', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.incrementTodayTransferCount('p');
    expect(redis.dump.has(`velocity:p:${easternDate(Date.now())}`)).toBe(true);
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
    await store.saveConversation('15551234567', [
      { role: 'user', content: 'hi' },
    ]);
    const conv = await store.getConversation('15551234567');
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
    await store.saveConversation('p', many);
    const conv = await store.getConversation('p');
    expect(conv).toHaveLength(40);
    expect(conv[conv.length - 1].content).toBe('m59');
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
