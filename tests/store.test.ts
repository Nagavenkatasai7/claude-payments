import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { SendBusyError } from '@/lib/send-limits';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedLedgerSpend } from './helpers-db';
import type { Db } from '@/db/client';
import type { Transfer, CorridorRequest } from '@/lib/types';

afterEach(() => vi.restoreAllMocks());

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

describe('store ledger totals (Program fix 16: no Redis counters)', () => {
  it('getTodayTransferCount is DERIVED from the ledger — blocked rows excluded, cancelled rows count — and the Redis increment is gone', async () => {
    const store = createStore(fakeRedis(), db);
    expect(await store.getTodayTransferCount('default', 'p')).toBe(0);
    await seedLedgerSpend(db, { partnerId: 'default', phone: 'p', amountUsd: 10 });
    await seedLedgerSpend(db, { partnerId: 'default', phone: 'p', amountUsd: 10, status: 'cancelled' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: 'p', amountUsd: 10, status: 'blocked' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: 'p', amountUsd: 10, createdAt: new Date(Date.now() - 2 * 86_400_000) });
    expect(await store.getTodayTransferCount('default', 'p')).toBe(2);
    expect(await store.getTodayTransferCount('acme', 'p')).toBe(0);
    expect('incrementTodayTransferCount' in store).toBe(false);
    // Review SHOULD 2: no `this` — the method survives destructuring / partial mocks.
    const { getTodayTransferCount } = store;
    expect(await getTodayTransferCount('default', 'p')).toBe(2);
  });

  it('senderTotals reads the ledger; a Redis flush mid-test leaves the totals unchanged (test 18)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await seedLedgerSpend(db, { partnerId: 'default', phone: 'p', amountUsd: 120.5 });
    await seedLedgerSpend(db, { partnerId: 'default', phone: 'p', amountUsd: 80, status: 'paid', createdAt: new Date(Date.now() - 2 * 86_400_000) });
    const before = await store.senderTotals('default', 'p');
    expect(before.todayUsdCents).toBe(12_050);
    expect(before.todayCount).toBe(1);
    // Yesterday's row is in the month total only when it is the same ET month —
    // relative dates, so assert the relation rather than a literal.
    expect(before.monthUsdCents).toBeGreaterThanOrEqual(12_050);
    redis.dump.clear();
    expect(await store.senderTotals('default', 'p')).toEqual(before);
    // No counter key was ever written.
    expect([...redis.dump.keys()].filter((k) => /^(daily_volume|monthly_volume|velocity):/.test(k))).toEqual([]);
  });

  it('capSubject: firstSeenAt from the customers row, else the first transfer, else now; kycStatus is the caller attestation', async () => {
    const store = createStore(fakeRedis(), db);
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    // (a) a customers row wins
    await createCustomerStore(db, store).saveCustomer({
      senderPhone: 'p1', firstSeenAt: fourDaysAgo, kycStatus: 'not_started', senderCountry: 'US', partnerId: 'default',
      createdAt: fourDaysAgo, updatedAt: fourDaysAgo,
    });
    const a = await store.capSubject('default', 'p1', 'verified');
    expect(a).toEqual({ firstSeenAt: fourDaysAgo, kycStatus: 'verified' });
    // (b) no row ⇒ the tenant's first transfer
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    await seedLedgerSpend(db, { partnerId: 'default', phone: 'p2', amountUsd: 10, createdAt: tenDaysAgo });
    expect((await store.capSubject('default', 'p2', 'verified')).firstSeenAt).toBe(tenDaysAgo.toISOString());
    // …and never another tenant's row or transfer
    const now = new Date();
    const c = await store.capSubject('acme', 'p2', 'verified', now);
    expect(c).toEqual({ firstSeenAt: now.toISOString(), kycStatus: 'verified' });
  });

  it('mintUnderSenderLock: READ COMMITTED, then SET LOCAL lock_timeout, then pg_advisory_xact_lock(hashtext($1)) BEFORE any statement on transfers (test 8)', async () => {
    const store = createStore(fakeRedis(), db);
    const txSpy = vi.spyOn(db, 'transaction');
    const stop = captureQueries();
    const minted = await store.mintUnderSenderLock('default', 'p', async (ops) => {
      const totals = await ops.totals();
      expect(totals.todayUsdCents).toBe(0);
      await ops.insertTransfer(sampleTransfer('lock_1', new Date().toISOString(), 'p'));
      return ops.getTransfer('lock_1');
    });
    const log = stop();
    expect(minted?.id).toBe('lock_1');
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy.mock.calls[0][1]).toEqual({ isolationLevel: 'read committed' });
    const sqls = log.map((q) => q.sql.toLowerCase());
    const iso = sqls.findIndex((q) => q.includes('set transaction isolation level read committed'));
    const to = sqls.findIndex((q) => q.includes("set local lock_timeout = '5s'"));
    const lock = sqls.findIndex((q) => q.includes('pg_advisory_xact_lock(hashtext($1))'));
    const firstTransfers = sqls.findIndex((q) => /\btransfers\b/.test(q));
    expect(iso).toBeGreaterThanOrEqual(0);
    expect(to).toBe(iso + 1);
    expect(lock).toBe(to + 1);
    expect(log[lock].params[0]).toBe('default:p');
    expect(firstTransfers).toBeGreaterThan(lock);
    // A committed insert is visible outside the lock.
    expect((await store.getTransfer('lock_1'))?.id).toBe('lock_1');
  });

  it('mintUnderSenderLock: a throw inside the body rolls the insert back and propagates', async () => {
    const store = createStore(fakeRedis(), db);
    await expect(
      store.mintUnderSenderLock('default', 'p', async (ops) => {
        await ops.insertTransfer(sampleTransfer('rb_1', new Date().toISOString(), 'p'));
        throw new Error('refused-after-insert');
      }),
    ).rejects.toThrow('refused-after-insert');
    expect(await store.getTransfer('rb_1')).toBeNull();
    expect(await store.getTodayTransferCount('default', 'p')).toBe(0);
  });

  it('mintUnderSenderLock maps SQLSTATE 55P03 (lock_timeout) to SendBusyError, direct or wrapped in cause', async () => {
    const store = createStore(fakeRedis(), db);
    const timeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(timeout);
    await expect(store.mintUnderSenderLock('default', 'p', async () => 'never')).rejects.toBeInstanceOf(SendBusyError);
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('Failed query', { cause: timeout }));
    await expect(store.mintUnderSenderLock('default', 'p', async () => 'never')).rejects.toBeInstanceOf(SendBusyError);
    // Any other error is NOT busy.
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(store.mintUnderSenderLock('default', 'p', async () => 'never')).rejects.toThrow('dup');
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

describe('per-(tenant, phone) agent-turn lock (Program-Fix 34A)', () => {
  it('tryTurnLock is SET NX EX 90 on turnlock:<tenant>:<phone>: the first holder wins, a second token is refused', async () => {
    const redis = fakeRedis();
    const setSpy = vi.spyOn(redis, 'set');
    const store = createStore(redis, db);
    expect(await store.tryTurnLock('acme', '15551230000', '101')).toBe(true);
    expect(setSpy).toHaveBeenCalledWith('turnlock:acme:15551230000', '101', { ex: 90, nx: true });
    expect(await store.tryTurnLock('acme', '15551230000', '102')).toBe(false);
    // Another phone, and the same phone under another tenant, are independent.
    expect(await store.tryTurnLock('acme', '15551239999', '103')).toBe(true);
    expect(await store.tryTurnLock('default', '15551230000', '104')).toBe(true);
  });

  it('releaseTurnLock deletes ONLY when the caller still holds it (a stranger token is a no-op)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis, db);
    await store.tryTurnLock('acme', '15551230000', '101');
    await store.releaseTurnLock('acme', '15551230000', '999'); // not ours
    expect(await store.tryTurnLock('acme', '15551230000', '102')).toBe(false);
    await store.releaseTurnLock('acme', '15551230000', '101'); // ours
    expect(await store.tryTurnLock('acme', '15551230000', '102')).toBe(true);
  });
});
