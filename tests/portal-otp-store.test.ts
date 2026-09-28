import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeRedis } from './helpers';
import type { RedisLike } from '@/lib/store';
import {
  createPortalOtpStore,
  PORTAL_OTP_POLICY,
  PORTAL_OTP_COUNTRIES,
  PORTAL_OTP_IP_LIMIT,
} from '@/lib/portal-otp-store';

// Fictitious numbers only (555-0100..0199; the repository is public).
const P = '+14155550101';
const P_DIGITS = '14155550101'; // normalizePhone strips everything but digits
const Q = '+14155550102';
const HOUR_MS_TEST = 3_600_000;
const DAY_MS_TEST = 86_400_000;
const WRONG = '999999';

// A fixed start early in its UTC day, so every multi-hour test stays inside one
// day: 1e12 % 86_400_000 = 6_400_000 ms (01:46:40 UTC), leaving > 22 h.
const START = 1_000_000_000_000;
expect(START % DAY_MS_TEST).toBe(6_400_000);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hOf = (pid: string, digits: string) => sha(`${pid}|${digits}`);

function mk(opts: { start?: number; codes?: number[]; redis?: RedisLike } = {}) {
  let t = opts.start ?? START;
  const redis = fakeRedis();
  const codes = [...(opts.codes ?? [])];
  const store = createPortalOtpStore(opts.redis ?? redis, {
    now: () => t,
    randomInt: () => (codes.length ? codes.shift()! : 42),
  });
  return {
    store,
    redis,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('portal OTP store: codes (SPEC §2.1)', () => {
  it('issues a 6-digit code (leading zeros kept) and stores only a hash, under an opaque tenant key', async () => {
    const { store, redis } = mk();
    const r = await store.issue('pa', P, 'login');
    expect(r).toEqual({ ok: true, code: '000042' });
    const raw = await redis.get(`potp:login:${hOf('pa', P_DIGITS)}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('000042');
    expect(JSON.parse(raw!).hash).toBe(sha('000042'));
    // No raw phone in ANY key or value.
    const all = [...redis.dump.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
    expect(all).not.toContain('4155550101');
    expect(all).not.toContain('000042');
  });

  it('pins the approved policy numbers and the per-IP limit M2-5 enforces', () => {
    expect(PORTAL_OTP_POLICY).toEqual({
      codeTtlMs: 300_000,
      cooldownMs: 60_000,
      maxSendsPerHourPerPhone: 5,
      maxSendsPerDayPerPhone: 10,
      maxFailuresPerWindow: 5,
      failWindowMs: 900_000,
      lockMs: 900_000,
      maxFailuresPerDay: 10,
      partnerSendsPerHour: 300,
      partnerSendsPerDay: 2_000,
    });
    expect(PORTAL_OTP_IP_LIMIT).toEqual({ scope: 'portalotp', limit: 20, windowSec: 3600 });
  });

  it('a code issued for partner A never verifies for partner B (same phone)', async () => {
    const { store } = mk();
    await store.issue('pa', P, 'login');
    expect(await store.verify('pb', P, '000042', 'login')).toEqual({ ok: false, reason: 'no_code' });
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: true });
  });

  it('is single-use and purpose-bound', async () => {
    const { store } = mk();
    await store.issue('pa', P, 'stepup');
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'no_code' });
    expect(await store.verify('pa', P, '000042', 'stepup')).toEqual({ ok: true });
    expect(await store.verify('pa', P, '000042', 'stepup')).toEqual({ ok: false, reason: 'no_code' });
  });

  it('phone formatting does not matter (the key is the normalized phone)', async () => {
    const { store } = mk();
    await store.issue('pa', '+1 (415) 555-0101', 'login');
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: true });
  });

  it('expires after 5 minutes', async () => {
    const { store, advance } = mk();
    await store.issue('pa', P, 'login');
    advance(PORTAL_OTP_POLICY.codeTtlMs - 1);
    expect(await store.verify('pa', P, '123456', 'login')).toEqual({ ok: false, reason: 'wrong' });
    advance(1);
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'expired' });
  });

  it('a fresh issue replaces the previous code (one live code per purpose)', async () => {
    const { store, advance } = mk({ codes: [111111, 222222] });
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: true, code: '111111' });
    advance(60_000);
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: true, code: '222222' });
    expect(await store.verify('pa', P, '111111', 'login')).toEqual({ ok: false, reason: 'wrong' });
    expect(await store.verify('pa', P, '222222', 'login')).toEqual({ ok: true });
  });

  it('malformed input never burns an attempt', async () => {
    const { store } = mk();
    await store.issue('pa', P, 'login');
    for (const bad of ['', '12345', 'abcdef', '1234567', ' 000042', '00004２']) {
      expect(await store.verify('pa', P, bad, 'login')).toEqual({ ok: false, reason: 'wrong' });
    }
    for (let i = 0; i < 20; i++) await store.verify('pa', P, 'x', 'login');
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: true });
  });

  it('a record with a corrupt expiry is treated as no code (never an eternal code)', async () => {
    const { store, redis } = mk();
    await redis.set(`potp:login:${hOf('pa', P_DIGITS)}`, JSON.stringify({ hash: sha('000042'), expMs: 'soon' }));
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'no_code' });
  });

  it('refuses unsupported geographies; the allow-list equals the legacy one', async () => {
    const { store } = mk();
    expect(await store.issue('pa', '+8610000000000', 'login')).toEqual({ ok: false, reason: 'unsupported_geo' });
    expect(await store.issue('pa', '', 'login')).toEqual({ ok: false, reason: 'unsupported_geo' });
    expect([...PORTAL_OTP_COUNTRIES].sort()).toEqual(['AE', 'AU', 'CA', 'GB', 'IN', 'NZ', 'SG', 'US']);
  });

  it('a correct code is consumed atomically: a resend landing mid-verify is never consumed by the old code', async () => {
    const base = fakeRedis();
    const newRecord = JSON.stringify({ hash: sha('777777'), expMs: START + 300_000 });
    // Between the read and the consume, a resend overwrites the record.
    const racing: RedisLike = {
      ...base,
      async getdel(key: string) {
        await base.set(key, newRecord);
        return base.getdel(key);
      },
    };
    const { store } = mk({ redis: racing });
    await store.issue('pa', P, 'login');
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'no_code' });
  });

  it('a newer code that raced in between the read and the consume survives (L1)', async () => {
    const base = fakeRedis();
    const newRecord = JSON.stringify({ hash: sha('777777'), expMs: START + 300_000 });
    let raced = false;
    const racing: RedisLike = {
      ...base,
      async getdel(key: string) {
        if (!raced) {
          raced = true;
          await base.set(key, newRecord);
        }
        return base.getdel(key);
      },
    };
    const { store } = mk({ redis: racing });
    await store.issue('pa', P, 'login');
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'no_code' });
    expect(await store.verify('pa', P, '777777', 'login')).toEqual({ ok: true });
  });

  it('two parallel correct submits: exactly one wins', async () => {
    const { store } = mk();
    await store.issue('pa', P, 'login');
    const rs = await Promise.all([
      store.verify('pa', P, '000042', 'login'),
      store.verify('pa', P, '000042', 'login'),
    ]);
    expect(rs.filter((r) => r.ok).length).toBe(1);
  });
});

/** Wraps a fake so every call is recorded as "<op>" (keys are opaque hashes, so op names suffice). */
function recording(base: RedisLike): { redis: RedisLike; ops: string[] } {
  const ops: string[] = [];
  const redis = Object.fromEntries(
    Object.entries(base)
      .filter(([, v]) => typeof v === 'function')
      .map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          const opts = args[2] as { nx?: boolean } | undefined;
          ops.push(name === 'set' && opts?.nx ? 'set:nx' : name);
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ]),
  ) as unknown as RedisLike;
  return { redis, ops };
}

describe('portal OTP store: equal Redis op sequences (no timing oracle)', () => {
  async function verifyOps(setup: (s: ReturnType<typeof mk>['store'], advance: (ms: number) => void) => Promise<void>, code: string) {
    const rec = recording(fakeRedis());
    const m = mk({ redis: rec.redis });
    await setup(m.store, m.advance);
    rec.ops.length = 0;
    const r = await m.store.verify('pa', P, code, 'login');
    return { r, ops: [...rec.ops] };
  }

  it('wrong, no_code and expired verifies perform the IDENTICAL Redis call sequence', async () => {
    const wrong = await verifyOps(async (s) => { await s.issue('pa', P, 'login'); }, WRONG);
    const noCode = await verifyOps(async () => {}, WRONG);
    const expired = await verifyOps(async (s, adv) => {
      await s.issue('pa', P, 'login');
      adv(PORTAL_OTP_POLICY.codeTtlMs);
    }, '000042');
    expect(wrong.r).toEqual({ ok: false, reason: 'wrong' });
    expect(noCode.r).toEqual({ ok: false, reason: 'no_code' });
    expect(expired.r).toEqual({ ok: false, reason: 'expired' });
    expect(noCode.ops).toEqual(wrong.ops);
    expect(expired.ops).toEqual(wrong.ops);
  });

  it('the sequence is also identical after prior failures (bucket TTL set without a count-dependent call)', async () => {
    const first = await verifyOps(async () => {}, WRONG);
    const third = await verifyOps(async (s) => {
      await s.verify('pa', P, WRONG, 'login');
      await s.verify('pa', P, WRONG, 'login');
    }, WRONG);
    expect(third.ops).toEqual(first.ops);
  });

  it('counter buckets get their TTL atomically with creation (SET NX EX, then INCR)', async () => {
    const rec = recording(fakeRedis());
    const m = mk({ redis: rec.redis });
    rec.ops.length = 0;
    await m.store.verify('pa', P, WRONG, 'login');
    expect(rec.ops).not.toContain('expire');
    expect(rec.ops.filter((o) => o === 'incr').length).toBe(2);
    expect(rec.ops.filter((o) => o === 'set:nx').length).toBe(2);
  });
});

describe('portal OTP store: send limits', () => {
  it('60 s resend cooldown; at most 5 sends per hour per (partner, phone); other partner unaffected', async () => {
    const { store, advance } = mk();
    expect((await store.issue('pa', P, 'login')).ok).toBe(true);
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: false, reason: 'cooldown' });
    expect(await store.issue('pa', P, 'stepup')).toEqual({ ok: false, reason: 'cooldown' }); // shared by both purposes
    expect((await store.issue('pb', P, 'login')).ok).toBe(true); // tenant-independent
    for (let i = 0; i < 4; i++) {
      advance(60_000);
      expect((await store.issue('pa', P, 'login')).ok).toBe(true);
    }
    advance(60_000);
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: false, reason: 'throttled' });
    advance(60_000);
    expect((await store.issue('pb', P, 'login')).ok).toBe(true); // B's hourly budget is its own
  });

  it('two parallel issues send ONE code (cooldown claimed with NX)', async () => {
    const { store } = mk();
    const rs = await Promise.all([store.issue('pa', P, 'login'), store.issue('pa', P, 'login')]);
    expect(rs.filter((r) => r.ok).length).toBe(1);
  });

  it('a stale cooldown key (TTL not yet fired) is released to exactly one of two parallel issues', async () => {
    const { store, advance } = mk();
    await store.issue('pa', P, 'login');
    advance(60_000); // the fake ignores TTL, so the old cooldown key is still present
    const rs = await Promise.all([store.issue('pa', P, 'login'), store.issue('pa', P, 'login')]);
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect(rs.filter((r) => !r.ok && r.reason === 'cooldown').length).toBe(1);
  });

  it('a cooldown stamped in the future (clock skew between instances) still counts as cooldown', async () => {
    const { store, redis, now } = mk();
    await redis.set(`potp:cd:${hOf('pa', P_DIGITS)}`, String(now() + 5_000));
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: false, reason: 'cooldown' });
  });

  it('at most 10 sends per day per (partner, phone)', async () => {
    const { store, advance } = mk();
    let ok = 0;
    for (let i = 0; i < 12; i++) {
      if ((await store.issue('pa', P, 'login')).ok) ok++;
      advance(HOUR_MS_TEST);
    }
    expect(ok).toBe(10);
    expect((await store.issue('pb', P, 'login')).ok).toBe(true);
  });

  it('per-partner hourly ceiling (anti-pumping) refuses only unknown numbers', async () => {
    const { store } = mk();
    // Fictitious numbers only: vary the AREA CODE, keep 555-01xx.
    const fake = (i: number) => `+1${200 + Math.floor(i / 100)}55501${String(i % 100).padStart(2, '0')}`;
    for (let i = 0; i < PORTAL_OTP_POLICY.partnerSendsPerHour; i++) {
      expect((await store.issue('pa', fake(i), 'login', { knownCustomer: false })).ok).toBe(true);
    }
    expect(await store.issue('pa', '+14155550199', 'login', { knownCustomer: false })).toEqual({
      ok: false,
      reason: 'partner_ceiling',
    });
    // knownCustomer defaults to false.
    expect(await store.issue('pa', '+14155550197', 'login')).toEqual({ ok: false, reason: 'partner_ceiling' });
    // A phone that is already this partner's customer still gets a code (O13).
    expect((await store.issue('pa', '+14155550198', 'login', { knownCustomer: true })).ok).toBe(true);
    expect((await store.issue('pb', '+14155550199', 'login', { knownCustomer: false })).ok).toBe(true);
  });

  it('per-partner daily ceiling (2,000) refuses only unknown numbers; other partners unaffected', async () => {
    const { store, redis, now } = mk();
    const day = Math.floor(now() / DAY_MS_TEST);
    await redis.set(`potp:pd:pa:${day}`, String(PORTAL_OTP_POLICY.partnerSendsPerDay));
    expect(await store.issue('pa', P, 'login', { knownCustomer: false })).toEqual({ ok: false, reason: 'partner_ceiling' });
    expect((await store.issue('pa', Q, 'login', { knownCustomer: true })).ok).toBe(true);
    expect((await store.issue('pb', P, 'login', { knownCustomer: false })).ok).toBe(true);
  });

  it('a locked phone is refused before any cooldown or send bucket is touched', async () => {
    const { store, redis, now } = mk();
    const h = hOf('pa', P_DIGITS);
    await redis.set(`potp:lock:${h}`, String(now() + 60_000));
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: false, reason: 'locked' });
    expect([...redis.dump.keys()].filter((k) => k !== `potp:lock:${h}`)).toEqual([]);
  });
});

describe('portal OTP store: failure budget (review round 1, H2 + M2)', () => {
  it('5 wrong attempts → locked for 15 min (issue AND verify refused), then usable again', async () => {
    const { store, advance } = mk();
    await store.issue('pa', P, 'login');
    for (let i = 0; i < 4; i++) expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'wrong' });
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' });
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'locked' });
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: false, reason: 'locked' });
    expect(await store.isLocked('pa', P)).toBe(true);
    expect(await store.isLocked('pb', P)).toBe(false);
    advance(PORTAL_OTP_POLICY.lockMs - 1);
    expect(await store.isLocked('pa', P)).toBe(true);
    advance(2);
    expect(await store.isLocked('pa', P)).toBe(false);
    expect((await store.issue('pa', P, 'login')).ok).toBe(true);
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: true });
  });

  it('the budget is shared by login and step-up', async () => {
    const { store } = mk();
    await store.issue('pa', P, 'login');
    for (let i = 0; i < 2; i++) await store.verify('pa', P, WRONG, 'login');
    for (let i = 0; i < 2; i++) await store.verify('pa', P, WRONG, 'stepup');
    expect(await store.verify('pa', P, WRONG, 'stepup')).toEqual({ ok: false, reason: 'locked' });
  });

  it('a parallel burst of 20 wrong guesses cannot exceed the budget (reserve-before-compare)', async () => {
    const { store } = mk();
    await store.issue('pa', P, 'login');
    const rs = await Promise.all(Array.from({ length: 20 }, () => store.verify('pa', P, WRONG, 'login')));
    expect(rs.filter((r) => !r.ok && r.reason === 'wrong').length).toBeLessThanOrEqual(4);
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('the failure budget SURVIVES resend: 4 wrong → resend → 1 wrong → locked', async () => {
    const { store, advance } = mk();
    await store.issue('pa', P, 'login');
    for (let i = 0; i < 4; i++) expect((await store.verify('pa', P, WRONG, 'login')).ok).toBe(false);
    advance(60_000);
    expect((await store.issue('pa', P, 'login')).ok).toBe(true);
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('a phone that was never sent a code locks exactly like one with a live code (no oracle)', async () => {
    const { store } = mk();
    await store.issue('pa', P, 'login');
    for (let i = 0; i < 4; i++) {
      expect((await store.verify('pa', P, WRONG, 'login')).ok).toBe(false);
      expect((await store.verify('pa', Q, WRONG, 'login')).ok).toBe(false);
    }
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' });
    expect(await store.verify('pa', Q, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('expired-code verifies cost the budget too', async () => {
    const { store, advance } = mk();
    await store.issue('pa', P, 'login');
    advance(PORTAL_OTP_POLICY.codeTtlMs);
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'expired' });
    for (let i = 0; i < 3; i++) expect((await store.verify('pa', P, WRONG, 'login')).ok).toBe(false);
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('a success refunds only its own reservation: 4 wrong → correct → resend → 1 wrong → locked', async () => {
    const { store, advance } = mk();
    await store.issue('pa', P, 'login');
    for (let i = 0; i < 4; i++) await store.verify('pa', P, WRONG, 'login');
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: true });
    advance(60_000); // same 15-min bucket (START is 100 s into its bucket)
    await store.issue('pa', P, 'login');
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('correct codes never consume the daily failure budget (success refund)', async () => {
    const { store, advance } = mk();
    for (let i = 0; i < 9; i++) {
      const purpose = i % 2 ? 'stepup' : 'login';
      expect((await store.issue('pa', P, purpose)).ok).toBe(true);
      expect(await store.verify('pa', P, '000042', purpose)).toEqual({ ok: true });
      advance(HOUR_MS_TEST);
    }
    await store.issue('pa', P, 'stepup');
    // Without the refund the daily counter would now read 10 → this single wrong guess would lock.
    expect(await store.verify('pa', P, WRONG, 'stepup')).toEqual({ ok: false, reason: 'wrong' });
    expect(await store.isLocked('pa', P)).toBe(false);
  });

  it('daily failure ceiling: 10 failures across windows → locked until the end of the UTC day', async () => {
    const { store, advance, now } = mk();
    for (let w = 0; w < 2; w++) {
      await store.issue('pa', P, 'login');
      for (let i = 0; i < 4; i++) await store.verify('pa', P, WRONG, 'login');
      advance(PORTAL_OTP_POLICY.failWindowMs);
    }
    await store.issue('pa', P, 'login');
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'wrong' }); // 9th
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' }); // 10th
    advance(PORTAL_OTP_POLICY.lockMs + 1);
    expect(await store.isLocked('pa', P)).toBe(true);
    expect(await store.issue('pa', P, 'login')).toEqual({ ok: false, reason: 'locked' });
    const midnight = (Math.floor(now() / DAY_MS_TEST) + 1) * DAY_MS_TEST;
    advance(midnight - now() - 1);
    expect(await store.isLocked('pa', P)).toBe(true);
    advance(1);
    expect(await store.isLocked('pa', P)).toBe(false);
    expect((await store.issue('pa', P, 'login')).ok).toBe(true);
  });

  it('the day lock holds even if a shorter lock value overwrites it (the daily counter is authoritative)', async () => {
    const { store, redis, advance, now } = mk();
    for (let w = 0; w < 2; w++) {
      await store.issue('pa', P, 'login');
      for (let i = 0; i < 4; i++) await store.verify('pa', P, WRONG, 'login');
      advance(PORTAL_OTP_POLICY.failWindowMs);
    }
    await store.issue('pa', P, 'login');
    await store.verify('pa', P, WRONG, 'login');
    await store.verify('pa', P, WRONG, 'login'); // 10th → midnight lock
    // A racing request armed only the 15-min lock last (last write wins).
    await redis.set(`potp:lock:${hOf('pa', P_DIGITS)}`, String(now() + PORTAL_OTP_POLICY.lockMs));
    advance(PORTAL_OTP_POLICY.lockMs + 1);
    expect(await store.isLocked('pa', P)).toBe(true);
    expect(await store.verify('pa', P, '000042', 'login')).toEqual({ ok: false, reason: 'locked' });
  });

  it('a corrupt lock value fails closed', async () => {
    const { store, redis } = mk();
    await redis.set(`potp:lock:${hOf('pa', P_DIGITS)}`, 'garbage');
    expect(await store.isLocked('pa', P)).toBe(true);
  });

  it('tenant isolation: A 4 failures + B 1 failure → B not locked', async () => {
    const { store } = mk();
    for (let i = 0; i < 4; i++) await store.verify('pa', P, WRONG, 'login');
    expect(await store.verify('pb', P, WRONG, 'login')).toEqual({ ok: false, reason: 'no_code' });
    expect(await store.isLocked('pb', P)).toBe(false);
    expect(await store.verify('pa', P, WRONG, 'login')).toEqual({ ok: false, reason: 'locked' });
    expect(await store.isLocked('pb', P)).toBe(false);
  });

  it('tenant isolation: A 15-min locked → B can issue and verify', async () => {
    const { store } = mk();
    for (let i = 0; i < 5; i++) await store.verify('pa', P, WRONG, 'login');
    expect(await store.isLocked('pa', P)).toBe(true);
    expect((await store.issue('pb', P, 'login')).ok).toBe(true);
    expect(await store.verify('pb', P, '000042', 'login')).toEqual({ ok: true });
  });

  it('tenant isolation: A day-locked → B unaffected', async () => {
    const { store, advance } = mk();
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < 5; i++) await store.verify('pa', P, WRONG, 'login');
      advance(PORTAL_OTP_POLICY.lockMs + 1);
    }
    expect(await store.isLocked('pa', P)).toBe(true); // 10 in the day
    expect(await store.isLocked('pb', P)).toBe(false);
    expect((await store.issue('pb', P, 'login')).ok).toBe(true);
    expect(await store.verify('pb', P, '000042', 'login')).toEqual({ ok: true });
  });
});

describe('portal OTP store: code confidentiality + after() safety', () => {
  it('never writes the code to the console across issue and verify', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { store, advance } = mk({ codes: [123456] });
    await store.issue('pa', P, 'login');
    await store.verify('pa', P, WRONG, 'login');
    await store.verify('pa', P, '123456', 'login');
    advance(PORTAL_OTP_POLICY.codeTtlMs);
    await store.verify('pa', P, '123456', 'login');
    const out = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).join(' ');
    expect(out).not.toContain('123456');
  });

  it('imports no logger, outbox or request-scoped Next API (runnable inside after(); codes never logged)', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/portal-otp-store.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l));
    for (const bad of [/['"]\.\/log['"]/, /['"]@\/lib\/log['"]/, /outbox/, /['"]next\//, /['"]next['"]/]) {
      expect(imports.filter((l) => bad.test(l))).toEqual([]);
    }
    expect(src).not.toMatch(/console\./);
  });
});
