import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDailyVolumeStore, getDailyVolumeStore } from '@/lib/daily-volume-store';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Program fix 16 (ruling 30): the daily-volume store is a LEDGER adapter. No
// Redis key, no addCents, no legacy dual-read — today's spend is the sum of
// the sender's non-blocked, non-cancelled rows since ET midnight.
const PHONE = '15551234567';
const OTHER = '15559999999';

let db: Db;
beforeEach(async () => {
  db = await freshDb(); // BEFORE any fake clock
});
afterEach(() => vi.useRealTimers());

describe('daily-volume store (ledger adapter)', () => {
  it('getTodayCents returns 0 when the sender has no rows', async () => {
    const dvs = createDailyVolumeStore(createStore(fakeRedis(), db));
    expect(await dvs.getTodayCents('default', PHONE)).toBe(0);
  });

  it('sums today\'s minted rows and excludes blocked + cancelled', async () => {
    const dvs = createDailyVolumeStore(createStore(fakeRedis(), db));
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 300 });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 50.25, status: 'paid' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 999, status: 'blocked' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 999, status: 'cancelled' });
    expect(await dvs.getTodayCents('default', PHONE)).toBe(35_025);
  });

  it('isolates per phone and per tenant', async () => {
    await seedPartner(db, 'acme');
    const dvs = createDailyVolumeStore(createStore(fakeRedis(), db));
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 300 });
    await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 50 });
    expect(await dvs.getTodayCents('default', OTHER)).toBe(0);
    expect(await dvs.getTodayCents('default', PHONE)).toBe(30_000);
    expect(await dvs.getTodayCents('acme', PHONE)).toBe(5_000);
  });

  it('isolates per ET calendar day (yesterday\'s spend is not today\'s)', async () => {
    const dvs = createDailyVolumeStore(createStore(fakeRedis(), db));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T18:00:00Z')); // 2pm ET
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 300 });
    expect(await dvs.getTodayCents('default', PHONE)).toBe(30_000);
    vi.setSystemTime(new Date('2026-05-25T18:00:00Z')); // next day 2pm ET
    expect(await dvs.getTodayCents('default', PHONE)).toBe(0);
    // 23:59 ET on the 24th still counts the 24th.
    vi.setSystemTime(new Date('2026-05-25T03:59:00Z'));
    expect(await dvs.getTodayCents('default', PHONE)).toBe(30_000);
  });

  it('never touches Redis and has no addCents', async () => {
    const redis = fakeRedis();
    const dvs = createDailyVolumeStore(createStore(redis, db));
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1 });
    await dvs.getTodayCents('default', PHONE);
    expect(redis.dump.size).toBe(0);
    expect('addCents' in dvs).toBe(false);
  });

  it('getDailyVolumeStore() builds over the process store (same surface)', () => {
    const dvs = getDailyVolumeStore();
    expect(typeof dvs.getTodayCents).toBe('function');
  });
});
