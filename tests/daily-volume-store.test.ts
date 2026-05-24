import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';
const OTHER = '15559999999';

beforeEach(() => {
  // Pin time to a known ET date for deterministic key naming
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-24T18:00:00Z')); // 2pm ET
});
afterEach(() => vi.useRealTimers());

describe('daily-volume store', () => {
  it('getTodayCents returns 0 when no spend recorded', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    expect(await dvs.getTodayCents(PHONE)).toBe(0);
  });

  it('addCents + getTodayCents round-trips', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 30_000); // $300
    expect(await dvs.getTodayCents(PHONE)).toBe(30_000);
  });

  it('multiple addCents calls accumulate', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 10_000);
    await dvs.addCents(PHONE, 25_000);
    expect(await dvs.getTodayCents(PHONE)).toBe(35_000);
  });

  it('isolates per phone', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 30_000);
    expect(await dvs.getTodayCents(OTHER)).toBe(0);
  });

  it('isolates per ET calendar day', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 30_000);
    vi.setSystemTime(new Date('2026-05-25T18:00:00Z')); // next day 2pm ET
    expect(await dvs.getTodayCents(PHONE)).toBe(0);
  });

  it('addCents sets a 48h TTL on the day key', async () => {
    const redis = fakeRedis();
    let capturedOpts: { ex?: number } | undefined;
    const origSet = redis.set.bind(redis);
    redis.set = async (k, v, o) => {
      if (k.startsWith('daily_volume:')) capturedOpts = o;
      return origSet(k, v, o);
    };
    const dvs = createDailyVolumeStore(redis);
    await dvs.addCents(PHONE, 1);
    expect(capturedOpts?.ex).toBe(48 * 60 * 60);
  });
});
