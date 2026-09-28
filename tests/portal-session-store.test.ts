import { describe, it, expect } from 'vitest';
import { fakeRedis, type FakeRedis } from './helpers';
import type { RedisLike } from '@/lib/store';
import {
  createPortalSessionStore,
  PORTAL_SESSION_POLICY,
  PORTAL_SESSION_COOKIE,
  portalSessionCookieOptions,
} from '@/lib/portal-session-store';

// M2-2 (UI redesign): the partner-bound portal session store. Phones are stored
// digits-only (the customers PK format), so '+1 415…' and '1415…' are one customer.
const P = '+14155550101';
const DAY = 86_400_000;

/**
 * The real Upstash client runs with automaticDeserialization:false, so HGETALL
 * returns a FLAT [f0, v0, f1, v1, …] array. The in-memory fake returns an object;
 * this wrapper reproduces the production shape.
 */
function flatHgetall(r: FakeRedis): RedisLike {
  return {
    ...r,
    async hgetall(key: string) {
      const h = await r.hgetall(key);
      if (!h) return null;
      return Object.entries(h).flat() as unknown as Record<string, string>;
    },
  };
}

function mk(redis: RedisLike = fakeRedis()) {
  let t = 1_800_000_000_000;
  const s = createPortalSessionStore(redis, { now: () => t });
  return { s, redis, adv: (ms: number) => { t += ms; }, now: () => t };
}

describe('portal session store (SPEC §2.1, §6 tenant isolation)', () => {
  it('uses its own __Host- cookie name, distinct from the legacy customer cookie', () => {
    expect(PORTAL_SESSION_COOKIE).toBe('__Host-sr_portal');
    expect(PORTAL_SESSION_COOKIE).not.toBe('__Host-sr_session');
  });

  it('a session minted on A is NOT accepted on B’s host (cookie replay)', async () => {
    const { s } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    expect((await s.resolve(token, 'pa'))?.partnerId).toBe('pa');
    expect(await s.resolve(token, 'pb')).toBeNull();
    // The refused replay did not damage the owner's session.
    expect(await s.resolve(token, 'pa')).not.toBeNull();
  });

  it('a replay on the wrong host does not slide the session', async () => {
    const { s, adv } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    adv(PORTAL_SESSION_POLICY.idleMs - 1000);
    expect(await s.resolve(token, 'pb')).toBeNull(); // must not refresh lastSeen
    adv(2000);
    expect(await s.resolve(token, 'pa')).toBeNull(); // idle since creation
  });

  it('30-day sliding idle: activity keeps it alive; 30 days of silence kills it', async () => {
    const { s, adv } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    for (let i = 0; i < 4; i++) {
      adv(20 * DAY);
      expect(await s.resolve(token, 'pa')).not.toBeNull();
    } // day 80
    adv(PORTAL_SESSION_POLICY.idleMs + 1);
    expect(await s.resolve(token, 'pa')).toBeNull();
  });

  it('90-day absolute cap: active through day 80, dead at day 91 however active (O1 addendum)', async () => {
    const { s, adv } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    for (let i = 0; i < 4; i++) {
      adv(20 * DAY);
      expect(await s.resolve(token, 'pa')).not.toBeNull();
    }
    adv(11 * DAY);
    expect(await s.resolve(token, 'pa')).toBeNull();
  });

  it('rotation on login: create(replaceToken) kills the old token', async () => {
    const { s } = mk();
    const a = await s.create('pa', P, 'Chrome on macOS');
    const b = await s.create('pa', P, 'Chrome on macOS', a.token);
    expect(await s.resolve(a.token, 'pa')).toBeNull();
    expect(await s.resolve(b.token, 'pa')).not.toBeNull();
    expect(b.sid).not.toBe(a.sid);
    expect((await s.list('pa', P)).map((d) => d.sid)).toEqual([b.sid]);
  });

  it('mints a 256-bit hex token and a 128-bit hex sid, fresh each time', async () => {
    const { s } = mk();
    const a = await s.create('pa', P, 'Chrome on macOS');
    const b = await s.create('pa', P, 'Chrome on macOS');
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.sid).not.toBe(b.sid);
  });

  it('stores the token only hashed: no Redis key or value contains the raw token', async () => {
    const redis = fakeRedis();
    const { s } = mk(redis);
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    for (const [k, v] of redis.dump) {
      expect(k).not.toContain(token);
      expect(v).not.toContain(token);
    }
    // The index is a hash: read it back through the store's own key shape.
    const all = JSON.stringify([...redis.dump.entries()]);
    expect(all).not.toContain(token);
  });

  it('no Redis key contains the phone or the partner id in clear', async () => {
    const redis = fakeRedis();
    const { s } = mk(redis);
    await s.create('partner-alpha', P, 'Chrome on macOS');
    for (const k of redis.dump.keys()) {
      expect(k).not.toContain('14155550101');
      expect(k).not.toContain('partner-alpha');
    }
  });

  it('stores the phone digits-only (the customers PK format)', async () => {
    const { s } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    expect((await s.resolve(token, 'pa'))?.phone).toBe('14155550101');
    // '+1 415…' and '1415…' are the same customer's device list.
    expect(await s.list('pa', '14155550101')).toHaveLength(1);
  });

  it('refuses an invalid phone or empty partner at create', async () => {
    const { s } = mk();
    await expect(s.create('pa', '12', 'Chrome on macOS')).rejects.toThrow();
    await expect(s.create('', P, 'Chrome on macOS')).rejects.toThrow();
  });

  it('malformed or unknown tokens resolve to null', async () => {
    const { s } = mk();
    await s.create('pa', P, 'Chrome on macOS');
    expect(await s.resolve('', 'pa')).toBeNull();
    expect(await s.resolve('not-a-token', 'pa')).toBeNull();
    expect(await s.resolve('a'.repeat(64), 'pa')).toBeNull();
    expect(await s.resolve('A'.repeat(64), 'pa')).toBeNull();
  });

  it('a corrupt record resolves to null rather than throwing', async () => {
    const redis = fakeRedis();
    const { s } = mk(redis);
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    for (const k of redis.dump.keys()) if (k.startsWith('psess:')) redis.dump.set(k, '{not json');
    expect(await s.resolve(token, 'pa')).toBeNull();
  });

  it('a record whose index entry is gone is dead (revocation cannot be escaped)', async () => {
    const redis = fakeRedis();
    const { s } = mk(redis);
    const { token, sid } = await s.create('pa', P, 'Chrome on macOS');
    // Simulate a lost record delete: drop only the index entry.
    const ix = await findIndexKey(redis, sid);
    expect(ix).not.toBeNull();
    await redis.hdel(ix!, sid);
    expect(await s.resolve(token, 'pa')).toBeNull();
  });

  it('an index entry that points at another token hash does not validate (constant-time compare)', async () => {
    const redis = fakeRedis();
    const { s } = mk(redis);
    const { token, sid } = await s.create('pa', P, 'Chrome on macOS');
    const ix = (await findIndexKey(redis, sid))!;
    await redis.hset(ix, { [sid]: 'f'.repeat(64) });
    expect(await s.resolve(token, 'pa')).toBeNull();
    await redis.hset(ix, { [sid]: 'short' });
    expect(await s.resolve(token, 'pa')).toBeNull();
  });

  it('step-up freshness: fresh at login, stale after 15 min, fresh again after markStepUp', async () => {
    const { s, adv } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    expect(s.isFresh((await s.resolve(token, 'pa'))!)).toBe(true);
    adv(PORTAL_SESSION_POLICY.stepUpFreshMs + 1);
    expect(s.isFresh((await s.resolve(token, 'pa'))!)).toBe(false);
    expect(await s.markStepUp(token, 'pa', { totp: false })).toBe(true);
    expect(s.isFresh((await s.resolve(token, 'pa'))!)).toBe(true);
  });

  it('step-up for a TOTP-enrolled customer: an OTP-only step-up is NOT fresh (review M4)', async () => {
    const { s, adv } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    // Login is a WhatsApp code only, so an enrolled customer is not fresh for TOTP.
    expect(s.isFresh((await s.resolve(token, 'pa'))!, { requireTotp: true })).toBe(false);
    adv(PORTAL_SESSION_POLICY.stepUpFreshMs + 1);
    await s.markStepUp(token, 'pa', { totp: false });
    expect(s.isFresh((await s.resolve(token, 'pa'))!, { requireTotp: true })).toBe(false);
    await s.markStepUp(token, 'pa', { totp: true });
    expect(s.isFresh((await s.resolve(token, 'pa'))!, { requireTotp: true })).toBe(true);
    adv(PORTAL_SESSION_POLICY.stepUpFreshMs + 1);
    expect(s.isFresh((await s.resolve(token, 'pa'))!, { requireTotp: true })).toBe(false);
  });

  it('a stale TOTP step-up paired with a fresh OTP is not fresh for an enrolled customer', async () => {
    const { s, adv } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    await s.markStepUp(token, 'pa', { totp: true });
    adv(PORTAL_SESSION_POLICY.stepUpFreshMs + 1);
    await s.markStepUp(token, 'pa', { totp: false });
    const sess = (await s.resolve(token, 'pa'))!;
    expect(s.isFresh(sess)).toBe(true);
    expect(s.isFresh(sess, { requireTotp: true })).toBe(false);
  });

  it('markStepUp refuses the wrong host, an unknown token and a dead session', async () => {
    const { s, adv } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    adv(PORTAL_SESSION_POLICY.stepUpFreshMs + 1);
    expect(await s.markStepUp(token, 'pb', { totp: false })).toBe(false);
    expect(s.isFresh((await s.resolve(token, 'pa'))!)).toBe(false); // B's host did not refresh A
    expect(await s.markStepUp('b'.repeat(64), 'pa', { totp: false })).toBe(false);
    adv(PORTAL_SESSION_POLICY.idleMs + 1);
    expect(await s.markStepUp(token, 'pa', { totp: false })).toBe(false);
  });

  it('isFresh clamps a caller maxAge to the policy window and rejects a future stamp', async () => {
    const { s, now } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    const sess = (await s.resolve(token, 'pa'))!;
    const old = { ...sess, authAtMs: now() - PORTAL_SESSION_POLICY.stepUpFreshMs - 1 };
    expect(s.isFresh(old, { maxAgeMs: 60 * DAY })).toBe(false);
    expect(s.isFresh({ ...sess, authAtMs: now() - 5 * 60_000 }, { maxAgeMs: 60_000 })).toBe(false);
    expect(s.isFresh({ ...sess, authAtMs: now() + 60_000 })).toBe(false);
  });

  it('devices: list/revoke/revokeAll stay inside (partner, phone)', async () => {
    const { s } = mk();
    const a1 = await s.create('pa', P, 'Safari on iPhone');
    const a2 = await s.create('pa', P, 'Chrome on macOS');
    const b1 = await s.create('pb', P, 'Firefox on Windows');
    expect((await s.list('pa', P)).map((d) => d.device).sort()).toEqual(['Chrome on macOS', 'Safari on iPhone']);
    expect(await s.revoke('pb', P, a1.sid)).toBe(false); // B cannot revoke A's device
    expect(await s.revoke('pa', '14155550199', a1.sid)).toBe(false); // nor another customer of A
    expect(await s.revoke('pa', P, a1.sid)).toBe(true);
    expect(await s.resolve(a1.token, 'pa')).toBeNull();
    expect(await s.revoke('pa', P, a1.sid)).toBe(false); // already gone
    expect(await s.revokeAll('pa', P, a2.sid)).toBe(0); // except current
    expect(await s.revokeAll('pa', P)).toBe(1);
    expect(await s.resolve(a2.token, 'pa')).toBeNull();
    expect(await s.resolve(b1.token, 'pb')).not.toBeNull(); // B untouched
    expect(await s.list('pa', P)).toEqual([]);
  });

  it('revoke refuses a malformed sid without touching Redis state', async () => {
    const { s } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    expect(await s.revoke('pa', P, '')).toBe(false);
    expect(await s.revoke('pa', P, '../x')).toBe(false);
    expect(await s.resolve(token, 'pa')).not.toBeNull();
  });

  it('destroy removes the session and its device entry', async () => {
    const { s } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    await s.destroy(token);
    expect(await s.resolve(token, 'pa')).toBeNull();
    expect(await s.list('pa', P)).toEqual([]);
    await expect(s.destroy('garbage')).resolves.toBeUndefined();
  });

  it('caps live sessions per customer at 10 (oldest evicted)', async () => {
    const { s, adv } = mk();
    const first = await s.create('pa', P, 'Chrome on macOS');
    for (let i = 1; i <= 10; i++) {
      adv(1000);
      await s.create('pa', P, 'Chrome on macOS');
    }
    expect(await s.resolve(first.token, 'pa')).toBeNull();
    expect((await s.list('pa', P)).length).toBe(10);
  });

  it('list is newest-activity first and drops dead sessions', async () => {
    const { s, adv } = mk();
    const a = await s.create('pa', P, 'Safari on iPhone');
    adv(1000);
    const b = await s.create('pa', P, 'Chrome on macOS');
    adv(1000);
    await s.resolve(a.token, 'pa'); // a is now the most recent
    expect((await s.list('pa', P)).map((d) => d.sid)).toEqual([a.sid, b.sid]);
    adv(PORTAL_SESSION_POLICY.idleMs + 1);
    expect(await s.list('pa', P)).toEqual([]);
  });

  it('list never exposes a token or token hash', async () => {
    const { s } = mk();
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    const out = await s.list('pa', P);
    expect(Object.keys(out[0]).sort()).toEqual(['createdAtMs', 'device', 'lastSeenMs', 'sid']);
    expect(JSON.stringify(out)).not.toContain(token.slice(0, 16));
  });

  it('device labels are a closed set: a raw user agent is stored as "Unknown device"', async () => {
    const { s } = mk();
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
    const { token } = await s.create('pa', P, ua);
    expect((await s.resolve(token, 'pa'))?.device).toBe('Unknown device');
    expect(JSON.stringify(await s.list('pa', P))).not.toContain('Mozilla');
  });

  it('works against the production HGETALL shape (flat array)', async () => {
    const { s, adv } = mk(flatHgetall(fakeRedis()));
    const a = await s.create('pa', P, 'Safari on iPhone');
    const b = await s.create('pa', P, 'Chrome on macOS');
    expect((await s.list('pa', P)).map((d) => d.sid).sort()).toEqual([a.sid, b.sid].sort());
    expect(await s.revokeAll('pa', P, b.sid)).toBe(1);
    expect(await s.resolve(a.token, 'pa')).toBeNull();
    for (let i = 0; i < 10; i++) {
      adv(1000);
      await s.create('pa', P, 'Chrome on macOS');
    }
    expect(await s.resolve(b.token, 'pa')).toBeNull(); // evicted as the oldest
    expect((await s.list('pa', P)).length).toBe(10);
  });

  it('Redis TTLs: index = 90-day absolute, re-armed on create; record ≤ idle and ≤ the absolute remainder', async () => {
    const base = fakeRedis();
    const expires: Array<[string, number]> = [];
    const sets: Array<[string, number | undefined]> = [];
    const redis: RedisLike = {
      ...base,
      async expire(key: string, s: number) {
        expires.push([key, s]);
        return base.expire(key, s);
      },
      async set(key: string, v: string, o?: { ex?: number; nx?: boolean }) {
        sets.push([key, o?.ex]);
        return base.set(key, v, o);
      },
    };
    const { s, adv } = mk(redis);
    const { token } = await s.create('pa', P, 'Chrome on macOS');
    expect(expires).toEqual([[expect.stringMatching(/^psess_ix:[0-9a-f]{64}$/), 90 * 86_400]]);
    expect(sets.at(-1)).toEqual([expect.stringMatching(/^psess:[0-9a-f]{64}$/), 30 * 86_400]);
    for (let i = 0; i < 4; i++) {
      adv(20 * DAY);
      await s.resolve(token, 'pa');
    }
    // Day 80: 10 days left before the absolute cap, so the record TTL is 10 days, not 30.
    expect(sets.at(-1)?.[1]).toBe(10 * 86_400);
    await s.create('pa', P, 'Safari on iPhone');
    expect(expires).toHaveLength(2); // re-armed
  });

  it('same phone under two partners = two independent sessions', async () => {
    const { s } = mk();
    const a = await s.create('pa', P, 'Chrome on macOS');
    const b = await s.create('pb', P, 'Chrome on macOS');
    expect(await s.revokeAll('pa', P)).toBe(1);
    expect(await s.resolve(a.token, 'pa')).toBeNull();
    expect((await s.resolve(b.token, 'pb'))?.partnerId).toBe('pb');
    expect(await s.list('pb', P)).toHaveLength(1);
  });
});

describe('portal session cookie options', () => {
  it('Secure, HttpOnly, SameSite=Lax, Path=/ and no other attribute (host-only: no domain)', () => {
    const o = portalSessionCookieOptions();
    expect(Object.keys(o).sort()).toEqual(['httpOnly', 'maxAge', 'path', 'sameSite', 'secure']);
    expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(o.maxAge).toBe(PORTAL_SESSION_POLICY.cookieMaxAgeS);
  });

  it('the cookie never outlives the 90-day absolute cap', () => {
    const created = 1_800_000_000_000;
    const o = portalSessionCookieOptions({ createdAtMs: created }, created + 80 * DAY);
    expect(o.maxAge).toBe(10 * 86_400);
    expect(portalSessionCookieOptions({ createdAtMs: created }, created + 91 * DAY).maxAge).toBe(0);
    expect(portalSessionCookieOptions({ createdAtMs: created }, created + DAY).maxAge).toBe(PORTAL_SESSION_POLICY.cookieMaxAgeS);
  });
});

/** Locate the device-index hash key holding `sid` (the fake keeps hashes apart from `dump`). */
async function findIndexKey(redis: FakeRedis, sid: string): Promise<string | null> {
  // The store's index key is psess_ix:<sha256(pid|phone)>; derive it the same way.
  const { createHash } = await import('node:crypto');
  const key = `psess_ix:${createHash('sha256').update('pa|14155550101').digest('hex')}`;
  return (await redis.hget(key, sid)) !== null ? key : null;
}
