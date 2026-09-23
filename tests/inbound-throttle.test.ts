import { describe, it, expect, vi } from 'vitest';
import { fakeRedis } from './helpers';
import {
  checkInboundThrottle,
  WA_TURNS_PER_MINUTE,
  WA_TURNS_PER_DAY,
} from '@/lib/inbound-throttle';

// Program-Fix 34A: the per-(tenant, phone) inbound throttle — owner-accepted
// 20 a minute and 300 a day. Pinned at the START of a minute window (and of a
// UTC day window) so a burst never straddles a boundary.
const DAY_START = Date.UTC(2026, 8, 22, 0, 0, 0);

describe('checkInboundThrottle', () => {
  it('the owner-accepted limits are 20/min and 300/day', () => {
    expect(WA_TURNS_PER_MINUTE).toBe(20);
    expect(WA_TURNS_PER_DAY).toBe(300);
  });

  it('allows 20 in a minute; the 21st is refused WITH one slow-down note, the 22nd is refused silently', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 20; i++) {
      expect(await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + i)).toEqual({ allowed: true });
    }
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + 20)).toEqual({ allowed: false, window: 'min', notify: true });
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + 21)).toEqual({ allowed: false, window: 'min', notify: false });
  });

  it('is per (tenant, phone): another phone and another tenant are unaffected', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 25; i++) await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + i);
    expect(await checkInboundThrottle(redis, 'acme', '15559990000', DAY_START + 30)).toEqual({ allowed: true });
    expect(await checkInboundThrottle(redis, 'default', '15551230000', DAY_START + 31)).toEqual({ allowed: true });
  });

  it('the next minute window allows again, and the slow-down note is once per window', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 21; i++) await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + i);
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + 60_000)).toEqual({ allowed: true });
    for (let i = 1; i < 20; i++) await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + 60_000 + i);
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + 60_000 + 50)).toEqual({ allowed: false, window: 'min', notify: true });
  });

  it('300 a day: the 301st message of the day (spread over minutes) is refused with one note for the day window', async () => {
    const redis = fakeRedis();
    let t = DAY_START;
    for (let i = 0; i < 300; i++) {
      if (i > 0 && i % 20 === 0) t += 60_000; // 20 per minute, never the minute limit
      expect((await checkInboundThrottle(redis, 'acme', '15551230000', t + (i % 20))).allowed).toBe(true);
    }
    t += 60_000;
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', t)).toEqual({ allowed: false, window: 'day', notify: true });
    t += 60_000;
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', t)).toEqual({ allowed: false, window: 'day', notify: false });
  });

  it('FAILS OPEN: a throwing Redis allows the message', async () => {
    const redis = fakeRedis();
    vi.spyOn(redis, 'incr').mockRejectedValue(new Error('upstash down'));
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START)).toEqual({ allowed: true });
  });

  it('over the limit, a failing note claim still refuses (no note, never a flood)', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 20; i++) await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + i);
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('upstash blip'));
    expect(await checkInboundThrottle(redis, 'acme', '15551230000', DAY_START + 20)).toEqual({ allowed: false, window: 'min', notify: false });
  });
});
