import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMonthlyVolumeStore, getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Program fix 16 (ruling 30): the monthly-volume store is a LEDGER adapter —
// the rolling-month EDD total is the sum of the sender's non-blocked,
// non-cancelled rows since the first of the ET month. No Redis, no addCents.
const PHONE = '15551234567';
const OTHER = '15559999999';

let db: Db;
beforeEach(async () => {
  db = await freshDb(); // BEFORE any fake clock
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-24T18:00:00Z')); // May 2026, 2pm ET
});
afterEach(() => vi.useRealTimers());

describe('monthly-volume store (ledger adapter)', () => {
  it('getMonthCents returns 0 when nothing was minted (dormant)', async () => {
    const mvs = createMonthlyVolumeStore(createStore(fakeRedis(), db));
    expect(await mvs.getMonthCents('default', PHONE)).toBe(0);
  });

  it('accumulates every send this month (catches structuring across many sends), excluding blocked + cancelled', async () => {
    const mvs = createMonthlyVolumeStore(createStore(fakeRedis(), db));
    const day = 86_400_000;
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1000, status: 'paid', createdAt: new Date(Date.now() - 10 * day) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 1500, status: 'delivered', createdAt: new Date(Date.now() - 3 * day) });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 600 });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 5000, status: 'blocked' });
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 5000, status: 'cancelled', createdAt: new Date(Date.now() - day) });
    expect(await mvs.getMonthCents('default', PHONE)).toBe(310_000);
  });

  it('isolates per phone and per tenant', async () => {
    await seedPartner(db, 'acme');
    const mvs = createMonthlyVolumeStore(createStore(fakeRedis(), db));
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 2500 });
    await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 100 });
    expect(await mvs.getMonthCents('default', OTHER)).toBe(0);
    expect(await mvs.getMonthCents('default', PHONE)).toBe(250_000);
    expect(await mvs.getMonthCents('acme', PHONE)).toBe(10_000);
  });

  it('isolates per ET calendar month (last month\'s spend does not count; the ET boundary applies)', async () => {
    const mvs = createMonthlyVolumeStore(createStore(fakeRedis(), db));
    // 2026-05-01 03:59Z is April 30, 23:59 ET — last month.
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 2500, status: 'paid', createdAt: new Date('2026-05-01T03:59:00Z') });
    // 2026-05-01 04:00Z is May 1, 00:00 ET — this month.
    await seedLedgerSpend(db, { partnerId: 'default', phone: PHONE, amountUsd: 200, status: 'paid', createdAt: new Date('2026-05-01T04:00:00Z') });
    expect(await mvs.getMonthCents('default', PHONE)).toBe(20_000);
    vi.setSystemTime(new Date('2026-06-02T18:00:00Z')); // June
    expect(await mvs.getMonthCents('default', PHONE)).toBe(0);
  });

  it('never touches Redis and has no addCents', async () => {
    const redis = fakeRedis();
    const mvs = createMonthlyVolumeStore(createStore(redis, db));
    await mvs.getMonthCents('default', PHONE);
    expect(redis.dump.size).toBe(0);
    expect('addCents' in mvs).toBe(false);
  });

  it('getMonthlyVolumeStore() builds over the process store (same surface)', () => {
    expect(typeof getMonthlyVolumeStore().getMonthCents).toBe('function');
  });
});
