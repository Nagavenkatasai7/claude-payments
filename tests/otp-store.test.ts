import { describe, it, expect } from 'vitest';
import { createOtpStore } from '@/lib/otp-store';
import { fakeRedis } from './helpers';

const US = '+12025550123'; // a US number (geo-allowed)
const DE = '+4915123456789'; // Germany — outside the 8-country allow-list

function mk(opts?: { rng?: () => number }) {
  const redis = fakeRedis();
  let t = 1_700_000_000_000;
  const store = createOtpStore(redis, {
    now: () => t,
    randomInt: opts?.rng ?? (() => 123_456),
  });
  return { store, redis, advance: (ms: number) => (t += ms) };
}

describe('otp-store issue/verify', () => {
  it('issues a 6-digit code and verifies it once (single-use)', async () => {
    const { store } = mk();
    const issued = await store.issueOtp(US, 'login');
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(await store.verifyOtp(US, issued.code, 'login')).toEqual({ ok: true });
    expect(await store.verifyOtp(US, issued.code, 'login')).toEqual({ ok: false, reason: 'no_code' });
  });

  it('keeps leading zeros (RNG 42 → 000042)', async () => {
    const { store } = mk({ rng: () => 42 });
    const issued = await store.issueOtp(US, 'login');
    expect(issued.ok && issued.code).toBe('000042');
  });

  it('stores a HASH (not the plaintext code) under an opaque key', async () => {
    const { store, redis } = mk();
    const issued = await store.issueOtp(US, 'login');
    if (!issued.ok) throw new Error('expected ok');
    const blob = [...redis.dump.values()].find((v) => v.includes('"hash"'));
    expect(blob).toBeDefined();
    expect(blob).not.toContain(issued.code);
    expect([...redis.dump.keys()].some((k) => k.includes(issued.code))).toBe(false);
  });
});

describe('otp-store purpose namespacing', () => {
  it('a login code cannot be redeemed as a reset code (separate keyspace)', async () => {
    const { store } = mk();
    const issued = await store.issueOtp(US, 'login');
    if (!issued.ok) throw new Error('expected ok');
    expect(await store.verifyOtp(US, issued.code, 'reset')).toEqual({ ok: false, reason: 'no_code' });
    expect(await store.verifyOtp(US, issued.code, 'login')).toEqual({ ok: true });
  });
});

describe('otp-store per-code burn + per-number daily fail-lock (resend cannot reset it)', () => {
  it('burns a code after 5 wrong guesses', async () => {
    const { store } = mk();
    await store.issueOtp(US, 'login');
    for (let i = 0; i < 5; i++) {
      expect(await store.verifyOtp(US, '000000', 'login')).toEqual({ ok: false, reason: 'wrong' });
    }
    expect(await store.verifyOtp(US, '000000', 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('locks the NUMBER for the day after 10 failures, across resends/new codes', async () => {
    const { store, advance } = mk();
    await store.issueOtp(US, 'login');
    for (let i = 0; i < 6; i++) await store.verifyOtp(US, '000000', 'login'); // 6 failures
    advance(31_000);
    await store.issueOtp(US, 'login'); // fresh code (resend)
    await store.verifyOtp(US, '000000', 'login'); // 7
    await store.verifyOtp(US, '000000', 'login'); // 8
    await store.verifyOtp(US, '000000', 'login'); // 9
    await store.verifyOtp(US, '000000', 'login'); // 10 → daily cap reached
    expect(await store.verifyOtp(US, '000000', 'login')).toEqual({ ok: false, reason: 'locked' });
    advance(31_000);
    expect(await store.issueOtp(US, 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('malformed input does NOT burn the code or count toward the daily lock', async () => {
    const { store } = mk();
    const issued = await store.issueOtp(US, 'login');
    if (!issued.ok) throw new Error('expected ok');
    for (let i = 0; i < 12; i++) {
      expect(await store.verifyOtp(US, '', 'login')).toEqual({ ok: false, reason: 'wrong' });
      expect(await store.verifyOtp(US, 'abc', 'login')).toEqual({ ok: false, reason: 'wrong' });
    }
    expect(await store.verifyOtp(US, issued.code, 'login')).toEqual({ ok: true });
  });
});

// Program-Fix 19 (F71): the per-code and per-day counters are RESERVED with an
// atomic INCR before any compare, so a parallel burst cannot all pass one read.
describe('otp-store atomic attempt caps (fix 19)', () => {
  it('a burst of 12 parallel wrong guesses gets at most 5 compares, the rest are locked', async () => {
    const { store } = mk();
    await store.issueOtp(US, 'login');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.verifyOtp(US, '000000', 'login')),
    );
    const rs = results.map((r) => (r.ok ? 'ok' : r.reason));
    expect(rs.filter((r) => r === 'wrong').length).toBeLessThanOrEqual(5);
    expect(rs.filter((r) => r === 'locked').length).toBeGreaterThanOrEqual(7);
    expect(rs).not.toContain('ok');
  });

  it('a burst hiding the right code never returns ok once 5 compares have run', async () => {
    const { store } = mk();
    const issued = await store.issueOtp(US, 'login');
    if (!issued.ok) throw new Error('expected ok');
    const guesses = Array.from({ length: 12 }, (_, i) => (i === 8 ? issued.code : '000000'));
    const results = await Promise.all(guesses.map((g) => store.verifyOtp(US, g, 'login')));
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).not.toContain('ok');
  });

  it('after 10 reserved verifies in a day, issueOtp is locked (a burst counts every reservation)', async () => {
    const { store, advance } = mk();
    await store.issueOtp(US, 'login');
    await Promise.all(Array.from({ length: 12 }, () => store.verifyOtp(US, '000000', 'login')));
    advance(31_000);
    expect(await store.issueOtp(US, 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('a verify with no live code burns nothing (no reservation without a record)', async () => {
    const { store, advance } = mk();
    for (let i = 0; i < 20; i++) {
      expect(await store.verifyOtp(US, '000000', 'login')).toEqual({ ok: false, reason: 'no_code' });
    }
    advance(31_000);
    const issued = await store.issueOtp(US, 'login');
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(await store.verifyOtp(US, issued.code, 'login')).toEqual({ ok: true });
  });

  it('a success consumes one daily reservation and clears the per-code counter', async () => {
    const { store, redis } = mk();
    const issued = await store.issueOtp(US, 'login');
    if (!issued.ok) throw new Error('expected ok');
    await store.verifyOtp(US, '000000', 'login');
    expect(await store.verifyOtp(US, issued.code, 'login')).toEqual({ ok: true });
    expect([...redis.dump.keys()].some((k) => k.startsWith('otp:att:'))).toBe(false);
    const day = [...redis.dump.entries()].find(([k]) => k.startsWith('otp:faillock:'));
    expect(day?.[1]).toBe('2');
  });
});

describe('otp-store throttling', () => {
  it('enforces a 30s resend cooldown independent of the code record', async () => {
    const { store, advance } = mk();
    expect((await store.issueOtp(US, 'login')).ok).toBe(true);
    const second = await store.issueOtp(US, 'login');
    expect(second.ok === false && second.reason).toBe('throttled');
    advance(31_000);
    expect((await store.issueOtp(US, 'login')).ok).toBe(true);
  });

  it('caps sends at 5/hour (atomic incr, no clobber)', async () => {
    const { store, advance } = mk();
    for (let i = 0; i < 5; i++) {
      expect((await store.issueOtp(US, 'login')).ok).toBe(true);
      advance(31_000);
    }
    const sixth = await store.issueOtp(US, 'login');
    expect(sixth.ok === false && sixth.reason).toBe('throttled');
  });
});

describe('otp-store geo allow-list', () => {
  it('refuses to send to a phone outside the 8 supported countries', async () => {
    const { store } = mk();
    expect(await store.issueOtp(DE, 'login')).toEqual({ ok: false, reason: 'unsupported_geo' });
  });
});
