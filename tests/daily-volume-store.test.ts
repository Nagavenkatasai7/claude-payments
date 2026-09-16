import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { fakeRedis } from './helpers';
import { easternDate } from '@/lib/dates';

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
    expect(await dvs.getTodayCents('default', PHONE)).toBe(0);
  });

  it('addCents + getTodayCents round-trips', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents('default', PHONE, 30_000); // $300
    expect(await dvs.getTodayCents('default', PHONE)).toBe(30_000);
  });

  it('multiple addCents calls accumulate', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents('default', PHONE, 10_000);
    await dvs.addCents('default', PHONE, 25_000);
    expect(await dvs.getTodayCents('default', PHONE)).toBe(35_000);
  });

  it('isolates per phone', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents('default', PHONE, 30_000);
    expect(await dvs.getTodayCents('default', OTHER)).toBe(0);
  });

  it('isolates per ET calendar day', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents('default', PHONE, 30_000);
    vi.setSystemTime(new Date('2026-05-25T18:00:00Z')); // next day 2pm ET
    expect(await dvs.getTodayCents('default', PHONE)).toBe(0);
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
    await dvs.addCents('default', PHONE, 1);
    expect(capturedOpts?.ex).toBe(48 * 60 * 60);
  });

  it('keys on (partnerId, phone): the same phone under two tenants has two counters', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents('default', PHONE, 30_000);
    expect(await dvs.getTodayCents('acme', PHONE)).toBe(0);
    await dvs.addCents('acme', PHONE, 5_000);
    expect(await dvs.getTodayCents('default', PHONE)).toBe(30_000);
    expect(await dvs.getTodayCents('acme', PHONE)).toBe(5_000);
  });

  it('TRANSITIONAL: the legacy phone-only key is read (and absorbed on the next add) so an in-flight cap is not reset — for the pre-fix tenant only', async () => {
    const redis = fakeRedis();
    await redis.set(`daily_volume:${PHONE}:${easternDate(Date.now())}`, '12000');
    // The store is handed the D9 resolver; here the phone's oldest row belongs to default.
    const dvs = createDailyVolumeStore(redis, async () => 'default');
    expect(await dvs.getTodayCents('default', PHONE)).toBe(12_000);
    expect(await dvs.getTodayCents('acme', PHONE)).toBe(0); // a post-fix sibling never inherits it
    await dvs.addCents('default', PHONE, 1_000);
    expect(await dvs.getTodayCents('default', PHONE)).toBe(13_000);
    // Without a resolver (the constructor default) there is NO fallback — fail closed.
    expect(await createDailyVolumeStore(redis).getTodayCents('default', '15550009999')).toBe(0);
  });
});
