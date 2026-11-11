import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fakeRedis } from './helpers';
import { isOtpConsumeFailure } from '@/lib/otp-consume-failure';
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
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true });
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

  it('the per-phone budget is scoped by caller kind: B2B at its cap never blocks the pay-page code', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await store.issue(`inv_${i}`, PHONE, { kind: 'b2b', partnerId: 'default' })).ok).toBe(true);
    }
    expect(await store.issue('inv_20', PHONE, { kind: 'b2b', partnerId: 'default' })).toEqual({ ok: false, reason: 'locked' });
    expect((await store.issue('transfer_1', PHONE, { kind: 'pay', partnerId: 'default' })).ok).toBe(true);
    expect((await store.issue('seller_1', PHONE, { kind: 'seller', partnerId: 'default' })).ok).toBe(true);
  });

  it('Stage C2: codes for AI-app-prepared drafts use their own budget: an app at its cap never blocks the pay-page code', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await store.issue(`draft_${i}`, PHONE, { kind: 'agent', partnerId: 'default' })).ok).toBe(true);
    }
    expect(await store.issue('draft_20', PHONE, { kind: 'agent', partnerId: 'default' })).toEqual({ ok: false, reason: 'locked' });
    expect((await store.issue('transfer_1', PHONE, { kind: 'pay', partnerId: 'default' })).ok).toBe(true);
  });

  it('the per-phone budget is scoped by partner: one partner at its cap never blocks another', async () => {
    for (let i = 0; i < 20; i++) await store.issue(`inv_${i}`, PHONE, { kind: 'b2b', partnerId: 'p_a' });
    expect((await store.issue('inv_20', PHONE, { kind: 'b2b', partnerId: 'p_a' })).ok).toBe(false);
    expect((await store.issue('inv_21', PHONE, { kind: 'b2b', partnerId: 'p_b' })).ok).toBe(true);
  });

  it('no budget argument means the pay budget of the default partner', async () => {
    for (let i = 0; i < 20; i++) await store.issue(`d_${i}`, PHONE);
    expect(await store.issue('d_20', PHONE, { kind: 'pay', partnerId: 'default' })).toEqual({ ok: false, reason: 'locked' });
    expect(phoneKeys().every((k) => k.startsWith('txotp:phone:pay:default:'))).toBe(true);
  });

  it('a refusal at the phone cap does not burn the transaction budget', async () => {
    for (let i = 0; i < 20; i++) await store.issue(`d_${i}`, PHONE);
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'locked' });
    expect(redis.dump.has(issuedKey(TX))).toBe(false);
  });

  it('a partner id is never written raw into a key beyond a safe charset', async () => {
    await store.issue(TX, PHONE, { kind: 'pay', partnerId: 'p a|b:c' });
    expect(phoneKeys()[0]).toMatch(/^txotp:phone:pay:p_a_b_c:[0-9a-f]{64}:\d+$/);
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
      getConsumeRedis: () => fakeRedis(),
    }));
    const mod = await import('@/lib/transaction-otp');
    await expect(mod.getTransactionOtpStore().issue(TX, PHONE)).rejects.toThrow('redis down');
    expect(raise).toHaveBeenCalledWith('txotp-issue', 'fail-closed');
  });

  // Review R3-Y1 Q2: the code's single-use GETDEL runs on the no-retry consume client
  // (getConsumeRedis), never on the retrying main client. Both fakes share one store.
  it("verify's code GETDEL runs on getConsumeRedis(), never on getRedis()", async () => {
    vi.resetModules();
    const base = fakeRedis();
    const mainGetdel = vi.fn((k: string) => base.getdel(k));
    const consumeGetdel = vi.fn((k: string) => base.getdel(k));
    const main = { ...base, getdel: mainGetdel };
    const consumeClient = { ...base, getdel: consumeGetdel };
    vi.doMock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/redis', () => ({ getRedis: () => main, getConsumeRedis: () => consumeClient }));
    const mod = await import('@/lib/transaction-otp');
    const otp = mod.getTransactionOtpStore();
    const issued = await otp.issue(TX, PHONE);
    if (!issued.ok) throw new Error('issue failed');
    expect(await otp.verify(TX, PHONE, issued.code)).toMatchObject({ ok: true });
    const codeKey = `txotp:${createHash('sha256').update(TX).digest('hex')}`;
    expect(consumeGetdel.mock.calls.filter(([k]) => k === codeKey)).toHaveLength(1);
    expect(mainGetdel.mock.calls.filter(([k]) => k === codeKey)).toHaveLength(0);
  });
});

// Program-Fix 25 PR B (§3.6 cooldown trap, review r1): a code whose SEND failed
// never reached the customer, so the 30-s cooldown is SHORTENED to a 10-s floor
// (not deleted): a retry soon works, but Resend cannot be hammered through the
// lifetime issue budget during a WhatsApp outage.
describe('transaction-otp shortenCooldown (Program-Fix 25 PR B)', { retry: 0 }, () => {
  it('an immediate re-issue is still in cooldown; after the 10-s floor it issues a fresh code', async () => {
    expect((await store.issue(TX, PHONE)).ok).toBe(true);
    await store.shortenCooldown(TX);
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'cooldown' });
    nowMs += 9_000;
    expect(await store.issue(TX, PHONE)).toEqual({ ok: false, reason: 'cooldown' });
    nowMs += 1_001;
    expect((await store.issue(TX, PHONE)).ok).toBe(true);
  });

  it('touches only the cooldown marker (every issue/verify budget is kept)', async () => {
    await store.issue(TX, PHONE);
    const before = new Map([...redis.dump.entries()].filter(([k]) => k !== cdKeyFor(TX)));
    await store.shortenCooldown(TX);
    const after = new Map([...redis.dump.entries()].filter(([k]) => k !== cdKeyFor(TX)));
    expect(after).toEqual(before);
    expect(redis.dump.has(cdKeyFor(TX))).toBe(true);
  });

  it('never LENGTHENS a cooldown that has less than 10 s left', async () => {
    await store.issue(TX, PHONE);
    nowMs += 25_000; // 5 s of the 30-s cooldown left
    await store.shortenCooldown(TX);
    nowMs += 5_001;
    expect((await store.issue(TX, PHONE)).ok).toBe(true);
  });
});

// Fix pack 4 (C5): a payment code is an authorisation record. The record carries
// issuedAt, verify reports issuedAt / attempt / channel, the delivery channel
// lives in a separate key, and a code is consumed atomically with GETDEL.
describe('transaction-otp - authorisation record (fix pack 4, C5)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const recKey = (tx: string) => `txotp:${sha(tx)}`;
  const chKey = (tx: string, issuedAt: number) => `txotp:ch:${sha(tx)}:${issuedAt}`;
  const chKeys = () => [...redis.dump.keys()].filter((k) => k.startsWith('txotp:ch:'));

  it('issue returns issuedAt = now and the record stores it', async () => {
    const issued = await store.issue(TX, PHONE);
    expect(issued).toEqual({ ok: true, code: '123456', issuedAt: nowMs });
    expect(JSON.parse(redis.dump.get(recKey(TX))!).issuedAt).toBe(nowMs);
  });

  it('verify ok returns { ok: true, issuedAt, attempt: 1, channel: null } when no delivery was noted', async () => {
    const issuedAt = nowMs;
    await store.issue(TX, PHONE);
    nowMs += 5_000;
    expect(await store.verify(TX, PHONE, '123456')).toEqual({ ok: true, issuedAt, attempt: 1, channel: null });
  });

  it('attempt is the per-code counter: one wrong guess then the right code -> attempt 2', async () => {
    await store.issue(TX, PHONE);
    expect((await store.verify(TX, PHONE, '000000')).ok).toBe(false);
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true, attempt: 2 });
  });

  it("noteDelivery(tx, issuedAt, 'tg') then verify -> channel 'tg'; the txotp:ch: key is gone afterwards", async () => {
    const issued = await store.issue(TX, PHONE);
    if (!issued.ok) throw new Error('issue failed');
    await store.noteDelivery(TX, issued.issuedAt, 'tg');
    expect(redis.dump.has(chKey(TX, issued.issuedAt))).toBe(true);
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true, channel: 'tg' });
    expect(chKeys()).toEqual([]);
  });

  it('a stale noteDelivery (the issuedAt of an earlier code) never tags a newer code', async () => {
    const first = await store.issue(TX, PHONE);
    if (!first.ok) throw new Error('issue failed');
    nowMs += 31_000;
    expect((await store.issue(TX, PHONE)).ok).toBe(true);
    await store.noteDelivery(TX, first.issuedAt, 'wa');
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true, channel: null });
  });

  it("an earlier code's channel note never carries over: it stays on that code's own key, which verify of the new code never reads (R1-P4 B1)", async () => {
    const first = await store.issue(TX, PHONE);
    if (!first.ok) throw new Error('issue failed');
    await store.noteDelivery(TX, first.issuedAt, 'wa');
    expect(chKeys()).toEqual([chKey(TX, first.issuedAt)]);
    nowMs += 31_000;
    const second = await store.issue(TX, PHONE);
    if (!second.ok) throw new Error('issue failed');
    expect(chKeys()).not.toContain(chKey(TX, second.issuedAt));
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true, channel: null });
    // The old note is left to its 10-minute TTL; it is never read again.
    expect(chKeys()).toEqual([chKey(TX, first.issuedAt)]);
  });

  it("noteDelivery with a null channel or a missing issuedAt writes nothing; a throwing redis.set never escapes", async () => {
    await store.issue(TX, PHONE);
    await store.noteDelivery(TX, nowMs, null);
    await store.noteDelivery(TX, undefined as never, 'wa');
    await store.noteDelivery(TX, Number.NaN, 'tg');
    expect(chKeys()).toEqual([]);
    for (const v of redis.dump.values()) expect(v).not.toContain('undefined|');
    const throwing = createTransactionOtpStore(
      { ...redis, set: async () => { throw new Error('redis down'); } },
      { now: () => nowMs },
    );
    await expect(throwing.noteDelivery(TX, nowMs, 'wa')).resolves.toBeUndefined();
  });

  it('a late noteDelivery after a successful verify never recreates the code', async () => {
    const issued = await store.issue(TX, PHONE);
    if (!issued.ok) throw new Error('issue failed');
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(true);
    await store.noteDelivery(TX, issued.issuedAt, 'wa');
    expect(await store.verify(TX, PHONE, '123456')).toEqual({ ok: false, reason: 'no_code' });
    expect(redis.dump.has(recKey(TX))).toBe(false);
  });

  it('consumption is atomic: two parallel verifies of the right code -> exactly one ok', async () => {
    await store.issue(TX, PHONE);
    const results = await Promise.all([
      store.verify(TX, PHONE, '123456'),
      store.verify(TX, PHONE, '123456'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'no_code' }]);
  });

  it('a re-issue racing a verify keeps the NEW code valid (critic C8/M5)', async () => {
    const reissuer = createTransactionOtpStore(redis, { now: () => nowMs, randomInt: () => 654321 });
    let raced = false;
    const sets: Array<{ key: string; ex?: number; nx?: boolean }> = [];
    const racing = {
      ...redis,
      async set(k: string, v: string, o?: { ex?: number; nx?: boolean }) {
        sets.push({ key: k, ex: o?.ex, nx: o?.nx });
        return redis.set(k, v, o);
      },
      async getdel(k: string) {
        if (!raced && k === recKey(TX)) {
          raced = true;
          nowMs += 31_000;
          const again = await reissuer.issue(TX, PHONE);
          expect(again.ok).toBe(true);
        }
        return redis.getdel(k);
      },
    };
    const racingStore = createTransactionOtpStore(racing, { now: () => nowMs, randomInt: () => 123456 });
    await racingStore.issue(TX, PHONE);
    sets.length = 0;
    expect(await racingStore.verify(TX, PHONE, '123456')).toEqual({ ok: false, reason: 'no_code' });
    const rec = JSON.parse(redis.dump.get(recKey(TX))!);
    expect(rec.codeHash).toBe(sha('654321'));
    expect(rec.issuedAt).toBe(nowMs);
    const restore = sets.find((s) => s.key === recKey(TX));
    expect(restore?.nx).toBe(true);
    expect(restore?.ex).toBeGreaterThan(0);
    expect(await store.verify(TX, PHONE, '654321')).toMatchObject({ ok: true });
  });

  it('a legacy record (no issuedAt, written by the previous build) verifies with issuedAt = expiresAt - 600000', async () => {
    const expiresAt = nowMs + 9 * 60 * 1000;
    redis.dump.set(
      recKey(TX),
      JSON.stringify({ codeHash: sha('123456'), phoneHash: sha(PHONE), attempts: 0, expiresAt }),
    );
    expect(await store.verify(TX, PHONE, '123456')).toEqual({
      ok: true,
      issuedAt: expiresAt - 600_000,
      attempt: 1,
      channel: null,
    });
  });

  it('the channel key holds only "<issuedAt>|wa|tg": never the id, phone or code', async () => {
    const issued = await store.issue(TX, PHONE);
    if (!issued.ok) throw new Error('issue failed');
    await store.noteDelivery(TX, issued.issuedAt, 'wa');
    const [k] = chKeys();
    expect(k).toBe(chKey(TX, issued.issuedAt));
    const v = redis.dump.get(k)!;
    expect(v).toBe(`${issued.issuedAt}|wa`);
    for (const s of [TX, PHONE, '123456']) {
      expect(k).not.toContain(s);
      expect(v).not.toContain(s);
    }
  });
});

// Fix pack 4 review R1-P4 (B1, B2, B3).
describe('transaction-otp - review R1-P4 (B1 channel note per code, B2 no-retry consume, B3 compare before burn)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const recKey = (tx: string) => `txotp:${sha(tx)}`;
  // An undici-shaped network failure: `TypeError: fetch failed` with a socket cause.
  const netError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

  it('B1: a late noteDelivery for an older code never overwrites the live code note (verify of the live code -> channel wa)', async () => {
    const a = await store.issue(TX, PHONE);
    if (!a.ok) throw new Error('issue A failed');
    nowMs += 31_000; // past the 30-s cooldown
    const b = await store.issue(TX, PHONE);
    if (!b.ok) throw new Error('issue B failed');
    await store.noteDelivery(TX, b.issuedAt, 'wa');
    await store.noteDelivery(TX, a.issuedAt, 'wa'); // A's send resolved late
    expect(await store.verify(TX, PHONE, '123456')).toEqual({ ok: true, issuedAt: b.issuedAt, attempt: 1, channel: 'wa' });
  });

  it("B1: the note key is txotp:ch:<sha(txId)>:<issuedAt>; an old-format key left by the previous build is ignored and harmless", async () => {
    const issued = await store.issue(TX, PHONE);
    if (!issued.ok) throw new Error('issue failed');
    redis.dump.set(`txotp:ch:${sha(TX)}`, `${issued.issuedAt}|tg`); // previous build's format
    await store.noteDelivery(TX, issued.issuedAt, 'wa');
    expect(redis.dump.get(`txotp:ch:${sha(TX)}:${issued.issuedAt}`)).toBe(`${issued.issuedAt}|wa`);
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true, channel: 'wa' });
    expect(redis.dump.has(`txotp:ch:${sha(TX)}:${issued.issuedAt}`)).toBe(false);
  });

  it('B2: the code GETDEL runs on the consume client; a network error there propagates and is never a no_code answer', async () => {
    // The main client behaves like the retrying Upstash client after a lost
    // response: the record is gone and the retried GETDEL answers null.
    const retrying = {
      ...redis,
      async getdel(k: string) {
        await redis.getdel(k);
        return null;
      },
    };
    const consumeCalls: string[] = [];
    const consume = {
      ...redis,
      async getdel(k: string) {
        consumeCalls.push(k);
        await redis.getdel(k); // executed on the server...
        throw netError(); // ...but the response was lost
      },
    };
    const s = createTransactionOtpStore(retrying, { now: () => nowMs, randomInt: () => 123456, consume });
    await s.issue(TX, PHONE);
    await expect(s.verify(TX, PHONE, '123456')).rejects.toThrow('fetch failed');
    expect(consumeCalls).toEqual([recKey(TX)]);
  });

  it('R2-Q1 B4: the consume throw is marked (isOtpConsumeFailure), the error itself unchanged; a string throw becomes a marked Error', async () => {
    const bare = new TypeError('fetch failed');
    const s = createTransactionOtpStore(redis, { now: () => nowMs, randomInt: () => 123456, consume: { ...redis, async getdel(): Promise<string | null> { throw bare; } } });
    await s.issue(TX, PHONE);
    const caught = await s.verify(TX, PHONE, '123456').catch((e: unknown) => e);
    expect(caught).toBe(bare);
    expect(isOtpConsumeFailure(caught)).toBe(true);
    expect(isOtpConsumeFailure(new TypeError('fetch failed'))).toBe(false);
    const r2 = fakeRedis();
    const s2 = createTransactionOtpStore(r2, { now: () => nowMs, randomInt: () => 123456, consume: { ...r2, async getdel(): Promise<string | null> { throw 'boom'; } } });
    await s2.issue(TX, PHONE);
    const caught2 = await s2.verify(TX, PHONE, '123456').catch((e: unknown) => e);
    expect(caught2).toBeInstanceOf(Error);
    expect(isOtpConsumeFailure(caught2)).toBe(true);
    expect(String((caught2 as Error).message)).not.toContain('123456');
  });

  it('B2: a consume client that throws before the server ran the command leaves the code valid for the retry', async () => {
    let fail = true;
    const consume = {
      ...redis,
      async getdel(k: string) {
        if (fail) {
          fail = false;
          throw netError();
        }
        return redis.getdel(k);
      },
    };
    const s = createTransactionOtpStore(redis, { now: () => nowMs, randomInt: () => 123456, consume });
    await s.issue(TX, PHONE);
    await expect(s.verify(TX, PHONE, '123456')).rejects.toThrow('fetch failed');
    expect(await s.verify(TX, PHONE, '123456')).toMatchObject({ ok: true, attempt: 2 });
  });

  // B3: a Resend that lands between verify's GET and its burn of an expired or
  // exhausted code must survive: the burn takes only the record it read.
  const racingBurn = () => {
    const reissuer = createTransactionOtpStore(redis, { now: () => nowMs, randomInt: () => 654321 });
    let raced = false;
    const race = async (k: string) => {
      if (!raced && k === recKey(TX)) {
        raced = true;
        expect((await reissuer.issue(TX, PHONE)).ok).toBe(true);
      }
    };
    return {
      ...redis,
      async del(k: string) {
        await race(k);
        return redis.del(k);
      },
      async getdel(k: string) {
        await race(k);
        return redis.getdel(k);
      },
    };
  };

  it('B3: a code re-issued while verify burns an EXPIRED code stays valid', async () => {
    const s = createTransactionOtpStore(racingBurn(), { now: () => nowMs, randomInt: () => 123456 });
    await s.issue(TX, PHONE);
    nowMs += 11 * 60 * 1000;
    expect(await s.verify(TX, PHONE, '123456')).toEqual({ ok: false, reason: 'expired' });
    expect(JSON.parse(redis.dump.get(recKey(TX))!).codeHash).toBe(sha('654321'));
    expect(await store.verify(TX, PHONE, '654321')).toMatchObject({ ok: true });
  });

  it('B3: a code re-issued while verify burns an EXHAUSTED code (attempt cap) stays valid', async () => {
    await store.issue(TX, PHONE);
    for (let i = 0; i < 5; i++) await store.verify(TX, PHONE, '000000');
    nowMs += 31_000; // past the cooldown, so the Resend can issue
    const s = createTransactionOtpStore(racingBurn(), { now: () => nowMs, randomInt: () => 123456 });
    expect(redis.dump.has(recKey(TX))).toBe(true); // 5 wrong guesses leave it; the 6th reservation burns it
    expect(await s.verify(TX, PHONE, '000000')).toEqual({ ok: false, reason: 'locked' });
    expect(await store.verify(TX, PHONE, '654321')).toMatchObject({ ok: true });
  });
});

// Review R3-Y1 O3: burn() runs its GETDEL on the retrying main client. When that GETDEL's response is
// lost, the retry answers null (the record is already gone). Whatever happens to the record, the
// expired and attempt-cap answers stay refusals, never ok.
describe('transaction-otp burn: a lost GETDEL response (R3-Y1 O3)', { retry: 0 }, () => {
  function lostResponseStore() {
    const base = fakeRedis();
    const lost = {
      ...base,
      getdel: async (k: string) => {
        await base.getdel(k); // the server ran it ...
        return null; // ... and the retried GETDEL answers null
      },
    };
    return createTransactionOtpStore(lost, { now: () => nowMs, randomInt: () => 123456, consume: base });
  }

  it('an expired code answers expired, never ok', async () => {
    const s = lostResponseStore();
    expect((await s.issue(TX, PHONE)).ok).toBe(true);
    nowMs += 11 * 60_000;
    expect(await s.verify(TX, PHONE, '123456')).toEqual({ ok: false, reason: 'expired' });
    expect((await s.verify(TX, PHONE, '123456')).ok).toBe(false);
  });

  it('past the attempt cap the right code answers locked, never ok', async () => {
    const s = lostResponseStore();
    expect((await s.issue(TX, PHONE)).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect((await s.verify(TX, PHONE, '000000')).ok).toBe(false);
    expect(await s.verify(TX, PHONE, '123456')).toEqual({ ok: false, reason: 'locked' });
    expect((await s.verify(TX, PHONE, '123456')).ok).toBe(false);
  });
});
