import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createTransactionOtpStore } from '@/lib/transaction-otp';

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
