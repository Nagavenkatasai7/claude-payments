import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fakeRedis } from './helpers';
import { createTransactionOtpStore } from '@/lib/transaction-otp';

const cdKeyFor = (txId: string) => `txotp:cd:${createHash('sha256').update(txId).digest('hex')}`;

const redis = fakeRedis();
let nowMs = 1_700_000_000_000;
const store = createTransactionOtpStore(redis, { now: () => nowMs, randomInt: () => 123456 });
const TX = 'draft_abc';
const PHONE = '15551230000';

beforeEach(() => {
  redis.dump.clear();
  nowMs = 1_700_000_000_000;
});

describe('transaction-otp', () => {
  it('issues a 6-digit code; verifies for the SAME tx+phone; consumes on success', async () => {
    const issued = await store.issue(TX, PHONE);
    expect(issued.ok && issued.code).toBe('123456');
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true });
    // single-use: a second verify fails
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false);
  });

  it('rejects a code from a DIFFERENT transaction or a DIFFERENT phone', async () => {
    await store.issue(TX, PHONE);
    expect((await store.verify('draft_other', PHONE, '123456')).ok).toBe(false);
    expect((await store.verify(TX, '19999999999', '123456')).ok).toBe(false);
  });

  it('expires after the TTL', async () => {
    await store.issue(TX, PHONE);
    nowMs += 11 * 60 * 1000;
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false);
  });

  it('burns after 5 wrong guesses', async () => {
    await store.issue(TX, PHONE);
    for (let i = 0; i < 5; i++) await store.verify(TX, PHONE, '000000');
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false); // burned even with the right code
  });

  it('30-s resend cooldown returns ok:false without a new code', async () => {
    await store.issue(TX, PHONE);
    expect((await store.issue(TX, PHONE)).ok).toBe(false);
  });
});

// Program-Fix 19 (F59/F60): every attempt is RESERVED atomically (INCR) before
// any compare, so a parallel burst cannot read one stale count and all pass.
describe('transaction-otp — atomic attempt caps (fix 19)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const reasons = (rs: Awaited<ReturnType<typeof store.verify>>[]) =>
    rs.map((r) => (r.ok ? 'ok' : r.reason));

  it('a burst of 20 parallel wrong guesses gets at most 5 compares; the rest are refused', async () => {
    await store.issue(TX, PHONE);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.verify(TX, PHONE, '000000')),
    );
    const rs = reasons(results);
    expect(rs.filter((r) => r === 'wrong').length).toBeLessThanOrEqual(5);
    expect(rs.every((r) => r === 'wrong' || r === 'locked' || r === 'no_code')).toBe(true);
    expect(rs).not.toContain('ok');
    // The code is burned: even the right code fails afterwards.
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false);
  });

  it('a burst hiding the right code at position 10 never returns ok once 5 compares have run', async () => {
    await store.issue(TX, PHONE);
    const guesses = Array.from({ length: 20 }, (_, i) => (i === 9 ? '123456' : '000000'));
    const results = await Promise.all(guesses.map((g) => store.verify(TX, PHONE, g)));
    expect(reasons(results)).not.toContain('ok');
  });

  it('caps wrong guesses per transaction at 15 per day across re-issues; the day bucket rolls', async () => {
    // 4 issues, each 31 s apart (past the cooldown); 15 wrong guesses in total.
    let wrong = 0;
    for (let round = 0; round < 4 && wrong < 15; round++) {
      if (round > 0) nowMs += 31_000;
      const issued = await store.issue(TX, PHONE);
      expect(issued.ok).toBe(true);
      for (let i = 0; i < 4 && wrong < 15; i++) {
        const r = await store.verify(TX, PHONE, '000000');
        expect(r.ok).toBe(false);
        wrong += 1;
      }
    }
    expect(wrong).toBe(15);
    // The 16th guess is refused as locked, and so is a fresh issue.
    expect(await store.verify(TX, PHONE, '000000')).toEqual({ ok: false, reason: 'locked' });
    nowMs += 31_000;
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'locked' });
    // After the day has rolled (relative clock seam), issuing works again.
    nowMs += DAY_MS + 1_000;
    const again = await store.issue(TX, PHONE);
    expect(again.ok).toBe(true);
    expect(await store.verify(TX, PHONE, '123456')).toEqual({ ok: true });
  });

  it('the daily ceiling is reserved too: a burst at 14 misses gets at most 1 more compare', async () => {
    // 3 issues, 5 + 5 + 4 wrong ⇒ 14 misses on the day.
    const plan = [5, 5, 4];
    for (let round = 0; round < plan.length; round++) {
      if (round > 0) nowMs += 31_000;
      expect((await store.issue(TX, PHONE)).ok).toBe(true);
      for (let i = 0; i < plan[round]; i++) await store.verify(TX, PHONE, '000000');
    }
    nowMs += 31_000;
    expect((await store.issue(TX, PHONE)).ok).toBe(true); // 14 < 15: allowed
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.verify(TX, PHONE, '000000')),
    );
    const rs = reasons(results);
    expect(rs.filter((r) => r === 'wrong').length).toBeLessThanOrEqual(1);
    expect(rs.filter((r) => r === 'locked').length).toBeGreaterThanOrEqual(4);
  });

  it('an old-build cooldown marker ("1") still counts as in-cooldown during the rolling release', async () => {
    await redis.set(cdKeyFor(TX), '1', { ex: 30 });
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'cooldown' });
  });

  it('keeps writing attempts:0 so the old build reads a number during the rolling release', async () => {
    await store.issue(TX, PHONE);
    // The code record itself (fix 45 added txotp:issued:/txotp:phone: counters beside it).
    const rec = [...redis.dump.entries()].find(([k]) => k === `txotp:${createHash('sha256').update(TX).digest('hex')}`);
    expect(JSON.parse(rec![1]).attempts).toBe(0);
  });

  it('never stores the code, only hashes, in any counter key or value', async () => {
    await store.issue(TX, PHONE);
    await store.verify(TX, PHONE, '000000');
    for (const [k, v] of redis.dump) {
      expect(k).not.toContain('123456');
      expect(k).not.toContain(TX);
      expect(v).not.toContain('123456');
    }
  });
});

// Program-Fix 45 (P2): issue caps. A lifetime cap per transaction and a daily
// cap per phone, both reserved with an atomic INCR AFTER the cooldown and the
// daily fail-cap refusals (so a refused request never burns the budget) and
// BEFORE a code is minted. A Redis error propagates: the send fails closed.
describe('transaction-otp — issue caps (fix 45)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const issuedKey = (tx: string) => `txotp:issued:${sha(tx)}`;
  const phoneKeys = () => [...redis.dump.keys()].filter((k) => k.startsWith('txotp:phone:'));

  it('allows 10 codes per transaction over its lifetime; the 11th is locked, even the next day', async () => {
    for (let i = 0; i < 10; i++) {
      if (i > 0) nowMs += 31_000;
      expect((await store.issue(TX, PHONE)).ok).toBe(true);
    }
    nowMs += 31_000;
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'locked' });
    nowMs += DAY_MS + 1_000; // lifetime, not daily
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'locked' });
  });

  it('allows 20 codes per phone per UTC day across transactions; the 21st is locked; the day rolls', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await store.issue(`draft_${i}`, PHONE)).ok).toBe(true);
    }
    expect(await store.issue('draft_20', PHONE)).toEqual({ ok: false, reason: 'locked' });
    // A different phone is unaffected.
    expect((await store.issue('draft_21', '15559990000')).ok).toBe(true);
    nowMs += DAY_MS;
    expect((await store.issue('draft_22', PHONE)).ok).toBe(true);
  });

  it('the phone cap ignores formatting: +1 555… and 1555… share one budget', async () => {
    for (let i = 0; i < 10; i++) await store.issue(`a_${i}`, PHONE);
    for (let i = 0; i < 10; i++) await store.issue(`b_${i}`, `+${PHONE}`);
    expect(await store.issue('c_0', PHONE)).toEqual({ ok: false, reason: 'locked' });
  });

  it('a cooldown refusal burns neither budget', async () => {
    await store.issue(TX, PHONE);
    expect(redis.dump.get(issuedKey(TX))).toBe('1');
    const phoneKey = phoneKeys()[0];
    expect(redis.dump.get(phoneKey)).toBe('1');
    for (let i = 0; i < 5; i++) {
      expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'cooldown' });
    }
    expect(redis.dump.get(issuedKey(TX))).toBe('1');
    expect(redis.dump.get(phoneKey)).toBe('1');
  });

  it('a daily fail-cap refusal burns neither budget', async () => {
    const t = nowMs;
    await redis.set(`txotp:fail:${sha(TX)}:${Math.floor(t / DAY_MS)}`, '15');
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'locked' });
    expect(redis.dump.has(issuedKey(TX))).toBe(false);
    expect(phoneKeys()).toEqual([]);
  });

  it('a refusal at the transaction cap does not touch the phone budget', async () => {
    await redis.set(issuedKey(TX), '10');
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'locked' });
    expect(phoneKeys()).toEqual([]);
  });

  it('a capped issue mints no code: the previous code stays the live one', async () => {
    await redis.set(issuedKey(TX), '10');
    expect((await store.issue(TX, PHONE)).ok).toBe(false);
    expect(await store.verify(TX, PHONE, '123456')).toEqual({ ok: false, reason: 'no_code' });
  });

  it('sets TTLs on first write: 8 days for the lifetime counter, past the day for the phone bucket', async () => {
    const expire = vi.spyOn(redis, 'expire');
    await store.issue(TX, PHONE);
    expect(expire).toHaveBeenCalledWith(issuedKey(TX), 8 * 24 * 60 * 60);
    expect(expire).toHaveBeenCalledWith(phoneKeys()[0], 2 * 24 * 60 * 60);
    expire.mockRestore();
  });

  it('keys hold only hashes: never the transaction id or the phone', async () => {
    await store.issue(TX, PHONE);
    for (const k of redis.dump.keys()) {
      expect(k).not.toContain(TX);
      expect(k).not.toContain(PHONE);
    }
  });

  it('fails closed on a Redis error: issue rejects, calls onStoreError once, and rethrows the original error', async () => {
    const boom = new Error('redis down');
    const onStoreError = vi.fn().mockResolvedValue(undefined);
    const broken = { ...redis, incr: async () => { throw boom; } };
    const s = createTransactionOtpStore(broken, { now: () => nowMs, onStoreError });
    await expect(s.issue(TX, PHONE)).rejects.toBe(boom);
    expect(onStoreError).toHaveBeenCalledTimes(1);
    expect(onStoreError).toHaveBeenCalledWith('txotp-issue');
    // No code record was written.
    expect([...redis.dump.keys()].some((k) => k === `txotp:${sha(TX)}`)).toBe(false);
  });

  it('a throwing onStoreError never replaces the original error', async () => {
    const boom = new Error('redis down');
    const broken = { ...redis, get: async () => { throw boom; } };
    const s = createTransactionOtpStore(broken, {
      now: () => nowMs,
      onStoreError: async () => { throw new Error('alert failed'); },
    });
    await expect(s.issue(TX, PHONE)).rejects.toBe(boom);
  });
});

describe('getTransactionOtpStore — wires the fail-closed ops signal (fix 45)', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/redis');
    vi.doUnmock('@/lib/limiter-alert');
    vi.resetModules();
  });

  it('a Redis error in issue raises the txotp-issue fail-closed alert and still rejects', async () => {
    vi.resetModules();
    const raise = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert: raise }));
    vi.doMock('@/lib/redis', () => ({
      getRedis: () => ({ ...fakeRedis(), get: async () => { throw new Error('redis down'); } }),
    }));
    const mod = await import('@/lib/transaction-otp');
    await expect(mod.getTransactionOtpStore().issue(TX, PHONE)).rejects.toThrow('redis down');
    expect(raise).toHaveBeenCalledWith('txotp-issue', 'fail-closed');
  });
});
