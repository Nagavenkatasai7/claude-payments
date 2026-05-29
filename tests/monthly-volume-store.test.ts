import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';
const OTHER = '15559999999';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-24T18:00:00Z')); // May 2026, 2pm ET
});
afterEach(() => vi.useRealTimers());

describe('monthly-volume store', () => {
  it('getMonthCents returns 0 when nothing recorded (dormant)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    expect(await mvs.getMonthCents(PHONE)).toBe(0);
  });

  it('addCents + getMonthCents round-trips', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 250_000); // $2,500
    expect(await mvs.getMonthCents(PHONE)).toBe(250_000);
  });

  it('multiple addCents accumulate (catches structuring across many sends)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 100_000);
    await mvs.addCents(PHONE, 150_000);
    await mvs.addCents(PHONE, 60_000);
    expect(await mvs.getMonthCents(PHONE)).toBe(310_000);
  });

  it('isolates per phone', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 250_000);
    expect(await mvs.getMonthCents(OTHER)).toBe(0);
  });

  it('isolates per ET calendar month (different month → separate counter)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 250_000);
    vi.setSystemTime(new Date('2026-06-15T18:00:00Z')); // June 2026
    expect(await mvs.getMonthCents(PHONE)).toBe(0);
  });

  it('addCents sets a 35-day TTL on the month key', async () => {
    const redis = fakeRedis();
    let capturedOpts: { ex?: number } | undefined;
    const origSet = redis.set.bind(redis);
    redis.set = async (k, v, o) => {
      if (k.startsWith('monthly_volume:')) capturedOpts = o;
      return origSet(k, v, o);
    };
    const mvs = createMonthlyVolumeStore(redis);
    await mvs.addCents(PHONE, 1);
    expect(capturedOpts?.ex).toBe(35 * 24 * 60 * 60);
  });
});
