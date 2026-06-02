import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createOtpStore } from '@/lib/otp-store';
import { fakeRedis } from './helpers';

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// A controllable clock + RNG so every test is deterministic.
function harness(opts: { startMs?: number; rng?: (maxExclusive: number) => number } = {}) {
  let nowMs = opts.startMs ?? 1_700_000_000_000; // fixed epoch
  const redis = fakeRedis();
  const store = createOtpStore(redis, {
    now: () => nowMs,
    // default RNG yields a mid-range 6-digit code unless a test overrides it
    randomInt: opts.rng ?? (() => 123456),
  });
  return {
    redis,
    store,
    advance(ms: number) {
      nowMs += ms;
    },
    setNow(ms: number) {
      nowMs = ms;
    },
  };
}

const PHONE = '+1 (555) 010-2030';
const NORMALIZED = '15550102030';
const PHONE_HASH = sha256hex(NORMALIZED);
const OTP_KEY = `otp:${PHONE_HASH}`;

describe('otp-store issueOtp', () => {
  it('returns a 6-digit code', async () => {
    const { store } = harness();
    const res = await store.issueOtp(PHONE);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toMatch(/^\d{6}$/);
      expect(res.code).toBe('123456');
    }
  });

  it('keeps leading zeros (RNG 42 -> "000042")', async () => {
    const { store } = harness({ rng: () => 42 });
    const res = await store.issueOtp(PHONE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.code).toBe('000042');
  });

  it('stores a HASH of the code under an opaque phone-hash key, never the code', async () => {
    const { store, redis } = harness();
    const res = await store.issueOtp(PHONE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Opaque key derived from sha256(normalized phone) — not the raw phone.
    const raw = redis.dump.get(OTP_KEY);
    expect(raw).toBeTruthy();
    expect(redis.dump.has(`otp:${NORMALIZED}`)).toBe(false);

    const stored = JSON.parse(raw!);
    expect(stored.hash).toBe(sha256hex(res.code));
    // The plaintext code must NOT be present anywhere in the stored blob.
    expect(raw).not.toContain(res.code);
    expect(stored.attempts).toBe(0);
  });

  it('normalizes the phone (formatting variants hit the same key)', async () => {
    const { store, redis } = harness();
    await store.issueOtp(PHONE);
    expect(redis.dump.has(OTP_KEY)).toBe(true);
  });
});

describe('otp-store verifyOtp', () => {
  it('succeeds once, then the code is consumed', async () => {
    const { store } = harness();
    const issued = await store.issueOtp(PHONE);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    expect(await store.verifyOtp(PHONE, issued.code)).toEqual({ ok: true });
    // consumed → second attempt has no live code
    expect(await store.verifyOtp(PHONE, issued.code)).toEqual({ ok: false, reason: 'no_code' });
  });

  it('returns no_code when nothing was issued', async () => {
    const { store } = harness();
    expect(await store.verifyOtp(PHONE, '000000')).toEqual({ ok: false, reason: 'no_code' });
  });

  it('resend overwrites: old code fails, new code works', async () => {
    let call = 0;
    const codes = [111111, 222222];
    const { store, advance } = harness({ rng: () => codes[call++] });

    const first = await store.issueOtp(PHONE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.code).toBe('111111');

    advance(31_000); // clear the 30s send-throttle
    const second = await store.issueOtp(PHONE);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.code).toBe('222222');

    expect(await store.verifyOtp(PHONE, '111111')).toEqual({ ok: false, reason: 'wrong' });
    expect(await store.verifyOtp(PHONE, '222222')).toEqual({ ok: true });
  });

  it('wrong code increments attempts; 6th wrong is locked + burned', async () => {
    const { store } = harness();
    const issued = await store.issueOtp(PHONE);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    for (let i = 0; i < 5; i++) {
      expect(await store.verifyOtp(PHONE, '000000')).toEqual({ ok: false, reason: 'wrong' });
    }
    // 6th wrong guess trips the cap → locked, and the code is burned.
    expect(await store.verifyOtp(PHONE, '000000')).toEqual({ ok: false, reason: 'locked' });
    // burned → even the correct code no longer verifies
    expect(await store.verifyOtp(PHONE, issued.code)).toEqual({ ok: false, reason: 'no_code' });
  });

  it('expired code → expired, and the record is removed', async () => {
    const { store, redis, advance } = harness();
    const issued = await store.issueOtp(PHONE);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    advance(300_001); // past the 300s TTL
    expect(await store.verifyOtp(PHONE, issued.code)).toEqual({ ok: false, reason: 'expired' });
    expect(redis.dump.has(OTP_KEY)).toBe(false);
  });
});

describe('otp-store send throttle', () => {
  it('a 2nd issue within 30s is throttled with a retryAfterMs', async () => {
    const { store, advance } = harness();
    expect((await store.issueOtp(PHONE)).ok).toBe(true);

    advance(10_000); // only 10s later
    const res = await store.issueOtp(PHONE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('throttled');
      expect(res.retryAfterMs).toBeGreaterThan(0);
      expect(res.retryAfterMs).toBeLessThanOrEqual(30_000);
    }
  });

  it('caps at 5 issues per hour', async () => {
    // Pin to an hour-bucket boundary so the 5 sends (155s span) stay in one hour.
    const HOUR = 60 * 60 * 1000;
    const hourStart = Math.floor(1_700_000_000_000 / HOUR) * HOUR;
    const { store, advance } = harness({ startMs: hourStart });
    for (let i = 0; i < 5; i++) {
      expect((await store.issueOtp(PHONE)).ok).toBe(true);
      advance(31_000); // clear the 30s throttle each time, stay within the hour
    }
    const res = await store.issueOtp(PHONE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('throttled');
  });

  it('caps at 10 issues per day', async () => {
    // Pin the clock to a day-bucket boundary so all 10 sends land in ONE day
    // window (the daily counter buckets by floor(now/86_400_000) — a fresh day
    // boundary mid-run would reset it, exactly as a TTL'd Redis day-counter does).
    const DAY = 24 * 60 * 60 * 1000;
    const dayStart = Math.floor(1_700_000_000_000 / DAY) * DAY;
    const { store, advance } = harness({ startMs: dayStart });
    // +2h per send → distinct hour buckets (dodges the 5/hr cap), last send at
    // +18h — still inside this day bucket.
    for (let i = 0; i < 10; i++) {
      expect((await store.issueOtp(PHONE)).ok).toBe(true);
      advance(2 * 60 * 60 * 1000);
    }
    const res = await store.issueOtp(PHONE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('throttled');
  });
});
