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
    expect(await mvs.getMonthCents('default', PHONE)).toBe(0);
  });

  it('addCents + getMonthCents round-trips', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents('default', PHONE, 250_000); // $2,500
    expect(await mvs.getMonthCents('default', PHONE)).toBe(250_000);
  });

  it('multiple addCents accumulate (catches structuring across many sends)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents('default', PHONE, 100_000);
    await mvs.addCents('default', PHONE, 150_000);
    await mvs.addCents('default', PHONE, 60_000);
    expect(await mvs.getMonthCents('default', PHONE)).toBe(310_000);
  });

  it('isolates per phone', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents('default', PHONE, 250_000);
    expect(await mvs.getMonthCents('default', OTHER)).toBe(0);
  });

  it('isolates per ET calendar month (different month → separate counter)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents('default', PHONE, 250_000);
    vi.setSystemTime(new Date('2026-06-15T18:00:00Z')); // June 2026
    expect(await mvs.getMonthCents('default', PHONE)).toBe(0);
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
    await mvs.addCents('default', PHONE, 1);
    expect(capturedOpts?.ex).toBe(35 * 24 * 60 * 60);
  });

  it('keys on (partnerId, phone): the same phone under two tenants has two counters', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents('default', PHONE, 30_000);
    expect(await mvs.getMonthCents('acme', PHONE)).toBe(0);
    await mvs.addCents('acme', PHONE, 5_000);
    expect(await mvs.getMonthCents('default', PHONE)).toBe(30_000);
    expect(await mvs.getMonthCents('acme', PHONE)).toBe(5_000);
  });

  it('TRANSITIONAL: the legacy phone-only key is read (and absorbed on the next add) so an in-flight cap is not reset — for the pre-fix tenant only', async () => {
    const redis = fakeRedis();
    await redis.set(`monthly_volume:${PHONE}:2026-05`, '12000');
    // The store is handed the D9 resolver; here the phone's oldest row belongs to default.
    const mvs = createMonthlyVolumeStore(redis, async () => 'default');
    expect(await mvs.getMonthCents('default', PHONE)).toBe(12_000);
    expect(await mvs.getMonthCents('acme', PHONE)).toBe(0); // a post-fix sibling never inherits it
    await mvs.addCents('default', PHONE, 1_000);
    expect(await mvs.getMonthCents('default', PHONE)).toBe(13_000);
    // Without a resolver (the constructor default) there is NO fallback — fail closed.
    expect(await createMonthlyVolumeStore(redis).getMonthCents('default', '15550009999')).toBe(0);
  });
});
