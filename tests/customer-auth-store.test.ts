import { describe, it, expect, vi } from 'vitest';
import { scryptSync, randomBytes, createHash } from 'node:crypto';

// Pass-through spy on hash-wasm's verify so the fix-21 test can COUNT the
// Argon2 work on the no-account path; everything else runs the real function.
const hw = vi.hoisted(() => ({ argon2Verify: vi.fn() }));
vi.mock('hash-wasm', async (orig) => {
  const real = await orig<typeof import('hash-wasm')>();
  hw.argon2Verify.mockImplementation(real.argon2Verify);
  return { ...real, argon2Verify: hw.argon2Verify };
});
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createCustomerAuthStore, CustomerInputError } from '@/lib/customer-auth-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { EnvKeyProvider, decryptField } from '@/lib/field-crypto';
import { verifyPassword } from '@/lib/password';
import type { Customer } from '@/lib/types';

// Fixed crypto provider so the email-encryption path never touches env.
const crypto = new EnvKeyProvider('0'.repeat(64));

const PHONE = '+1 (555) 010-2030'; // normalizes to 15550102030
const NORM = '15550102030';

// A legacy scrypt hash in the exact `salt:hash` shape password.ts understands,
// so the lazy-rehash path can be exercised without a pepper.
function legacyScryptHash(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Customer RECORDS live in Postgres now (pg-backed customer store); sessions /
// reset tokens / throttles stay on the injected Redis (sr_* keys).
async function mkAuth(redis = fakeRedis(), now?: () => number) {
  const db = await freshDb();
  const customers = createCustomerStore(db, createStore(fakeRedis(), db));
  const s = createCustomerAuthStore(redis, customers, now ? { now } : {});
  return { s, customers, db };
}

function neverPwned() {
  return async () => false;
}

describe('registerCustomer', () => {
  it('attaches an account to a lazily-created Customer, argon2-hashes the password and encrypts the email', async () => {
    const { s, customers } = await mkAuth();
    const c = await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'correct horse battery' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );

    expect(c.senderPhone).toBe(NORM);
    expect(c.partnerId).toBe('default');
    expect(c.senderCountry).toBe('US');
    expect(c.passwordHash?.startsWith('$argon2id$')).toBe(true);
    expect(c.passwordUpdatedAt).toBeTruthy();
    // email is a ciphertext blob, not the plaintext
    expect(c.email).toBeTruthy();
    expect(c.email).not.toContain('a@example.com');
    expect(decryptField(c.email!, crypto)).toBe('a@example.com');
    expect(await verifyPassword('correct horse battery', c.passwordHash!)).toBe(true);

    // persisted in the customer store
    const persisted = await customers.getCustomer('default', NORM);
    expect(persisted).toBeTruthy();
    expect(persisted!.passwordHash).toBe(c.passwordHash);
  });

  it('attaches to an EXISTING Customer record without clobbering its kyc fields', async () => {
    const { s, customers } = await mkAuth();
    const existing: Customer = {
      senderPhone: NORM,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'grandfathered',
      senderCountry: 'US',
      partnerId: 'default',
      optInAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await customers.saveCustomer(existing);

    const c = await s.registerCustomer(
      { phone: NORM, email: 'b@example.com', password: 'another good one!!' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    expect(c.kycStatus).toBe('grandfathered');
    expect(c.optInAt).toBe('2026-01-01T00:00:00.000Z');
    expect(c.passwordHash).toBeTruthy();
  });

  it('throws a collision error when an account already exists for the number', async () => {
    const { s } = await mkAuth();
    await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'first password ok' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'second password ok' },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow(/can't set up an account for this number/i);
  });

  it('throws on an invalid phone', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: '123', email: 'a@example.com', password: 'good password here' },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow();
  });

  it('throws when the password is too short', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'short' },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow(/8/);
  });

  it('throws when the password is too long', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'x'.repeat(65) },
        { pwnedCheck: neverPwned(), cryptoProvider: crypto },
      ),
    ).rejects.toThrow();
  });

  it('throws when the password is found in a breach corpus', async () => {
    const { s } = await mkAuth();
    await expect(
      s.registerCustomer(
        { phone: PHONE, email: 'a@example.com', password: 'breached password' },
        { pwnedCheck: async () => true, cryptoProvider: crypto },
      ),
    ).rejects.toThrow(/data breach/i);
  });

  it('fails open: a pwnedCheck that throws does not block registration', async () => {
    const { s } = await mkAuth();
    const c = await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'resilient password' },
      {
        pwnedCheck: async () => {
          throw new Error('HIBP unreachable');
        },
        cryptoProvider: crypto,
      },
    );
    expect(c.passwordHash).toBeTruthy();
  });
});

describe('verifyCustomerPassword', () => {
  it('returns the customer on a correct password and null on a wrong one', async () => {
    const { s } = await mkAuth();
    await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'the right password' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    expect(await s.verifyCustomerPassword(PHONE, 'the right password')).not.toBeNull();
    expect(await s.verifyCustomerPassword(PHONE, 'the wrong password')).toBeNull();
  });

  it('returns null when no account exists / no passwordHash', async () => {
    const { s, customers } = await mkAuth();
    expect(await s.verifyCustomerPassword(PHONE, 'whatever1234')).toBeNull();

    // record exists but has no passwordHash
    await customers.saveCustomer({
      senderPhone: NORM,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'not_started',
      senderCountry: 'US',
      partnerId: 'default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await s.verifyCustomerPassword(PHONE, 'whatever1234')).toBeNull();
  });

  it('runs exactly one Argon2 verify for an UNKNOWN phone (fix 21: no timing oracle)', async () => {
    const { s } = await mkAuth();
    hw.argon2Verify.mockClear();
    expect(await s.verifyCustomerPassword('+1 (555) 010-9999', 'x')).toBeNull();
    expect(hw.argon2Verify).toHaveBeenCalledTimes(1);
  });

  it('lazily re-hashes a legacy scrypt hash to argon2 on a successful verify', async () => {
    const { s, customers } = await mkAuth();
    const legacy = legacyScryptHash('legacy secret pw');
    expect(legacy.startsWith('$argon2id$')).toBe(false);
    await customers.saveCustomer({
      senderPhone: NORM,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'not_started',
      senderCountry: 'US',
      partnerId: 'default',
      passwordHash: legacy,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const c = await s.verifyCustomerPassword(PHONE, 'legacy secret pw');
    expect(c).not.toBeNull();
    const persisted = (await customers.getCustomer('default', NORM))!;
    expect(persisted.passwordHash?.startsWith('$argon2id$')).toBe(true);
    // still verifies after the upgrade
    expect(await verifyPassword('legacy secret pw', persisted.passwordHash!)).toBe(true);
  });
});

describe('sessions', () => {
  it('creates a session and resolves it back to the phone', async () => {
    const { s } = await mkAuth();
    const token = await s.createSession(NORM, 'default');
    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.getSession(token)).toBe(NORM);
  });

  it('does not store the raw token as a key (hashed at rest)', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    const token = await s.createSession(NORM, 'default');
    expect([...redis.dump.keys()].some((k) => k.includes(token))).toBe(false);
  });

  it('deletes a session', async () => {
    const { s } = await mkAuth();
    const token = await s.createSession(NORM, 'default');
    await s.deleteSession(token);
    expect(await s.getSession(token)).toBeNull();
  });

  it('rejects after the 30-minute idle window', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    const token = await s.createSession(NORM, 'default');
    now += 31 * 60 * 1000; // 31 min idle
    expect(await s.getSession(token)).toBeNull();
  });

  it('refreshes lastSeen on access so steady activity keeps a session alive past 30 min', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    const token = await s.createSession(NORM, 'default');
    now += 20 * 60 * 1000;
    expect(await s.getSession(token)).toBe(NORM); // refresh
    now += 20 * 60 * 1000; // 20 more, but idle since refresh is only 20
    expect(await s.getSession(token)).toBe(NORM);
  });

  it('rejects after the 12-hour absolute window even with continuous activity', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    const token = await s.createSession(NORM, 'default');
    // keep refreshing every 10 min for >12h
    for (let i = 0; i < 80; i++) {
      now += 10 * 60 * 1000;
      await s.getSession(token);
    }
    // we are now ~13.3h past creation
    expect(await s.getSession(token)).toBeNull();
  });

  it('deleteAllSessions revokes every live session for the phone but not others', async () => {
    const { s } = await mkAuth();
    const t1 = await s.createSession(NORM, 'default');
    const t2 = await s.createSession(NORM, 'default');
    const tOther = await s.createSession('19998887777', 'default');
    await s.deleteAllSessions(NORM);
    expect(await s.getSession(t1)).toBeNull();
    expect(await s.getSession(t2)).toBeNull();
    expect(await s.getSession(tOther)).toBe('19998887777');
  });
});

describe('reset tokens', () => {
  it('issues a token that consumes to the phone exactly once (single-use)', async () => {
    const { s } = await mkAuth();
    const token = await s.createResetToken(NORM);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.consumeResetToken(token)).toBe(NORM);
    // second consume returns null
    expect(await s.consumeResetToken(token)).toBeNull();
  });

  it('returns null for an unknown / forged reset token', async () => {
    const { s } = await mkAuth();
    expect(await s.consumeResetToken('deadbeef')).toBeNull();
  });

  it('does not store the raw reset token as a key (hashed at rest)', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    const token = await s.createResetToken(NORM);
    expect([...redis.dump.keys()].some((k) => k.includes(token))).toBe(false);
  });
});

// Program-Fix 19 (F71/F67): every password check RESERVES its attempt with an
// atomic INCR first; three ceilings — 10/hour per (phone, IP), 30/day per phone,
// 50/hour per IP — and a stranger from one IP can no longer lock the owner out.
describe('reserveLoginAttempt (fix 19)', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  it('is atomic: 25 parallel reservations from one IP yield exactly 10 true', async () => {
    const { s } = await mkAuth();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => s.reserveLoginAttempt(PHONE, 'ip-A')),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it('locks (phone, ip-A) after 10 while (phone, ip-B) still proceeds — no third-party lockout', async () => {
    const { s } = await mkAuth();
    for (let i = 0; i < 10; i++) expect(await s.reserveLoginAttempt(PHONE, 'ip-A')).toBe(true);
    expect(await s.reserveLoginAttempt(PHONE, 'ip-A')).toBe(false);
    expect(await s.reserveLoginAttempt(PHONE, 'ip-B')).toBe(true);
  });

  it('a locked stranger IP hammering on does NOT advance the per-phone day counter', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    for (let i = 0; i < 40; i++) await s.reserveLoginAttempt(PHONE, 'ip-A'); // 10 pass, 30 refused
    const dayKey = [...redis.dump.keys()].find((k) => k.startsWith(`sr_loginfail:p:${NORM}:`));
    expect(dayKey).toBeDefined();
    expect(redis.dump.get(dayKey!)).toBe('10');
    expect(await s.reserveLoginAttempt(PHONE, 'ip-B')).toBe(true);
  });

  it('30 reservations over 4 IPs lock the phone for every IP until the day bucket rolls', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    const ips = ['ip-A', 'ip-B', 'ip-C', 'ip-D'];
    for (let i = 0; i < 30; i++) expect(await s.reserveLoginAttempt(PHONE, ips[i % 4])).toBe(true);
    expect(await s.reserveLoginAttempt(PHONE, 'ip-E')).toBe(false); // never seen this IP; phone ceiling
    now += DAY_MS + 1000;
    expect(await s.reserveLoginAttempt(PHONE, 'ip-E')).toBe(true);
  });

  it('the (phone, IP) hourly bucket rolls after an hour; the phone/day ceiling still holds', async () => {
    let now = 1_000_000;
    const { s } = await mkAuth(fakeRedis(), () => now);
    for (let i = 0; i < 10; i++) await s.reserveLoginAttempt(PHONE, 'ip-A');
    expect(await s.reserveLoginAttempt(PHONE, 'ip-A')).toBe(false);
    now += HOUR_MS;
    expect(await s.reserveLoginAttempt(PHONE, 'ip-A')).toBe(true);
  });

  it('caps one IP at 50 reservations an hour across phones', async () => {
    const { s } = await mkAuth();
    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      if (await s.reserveLoginAttempt(`1555010${String(2100 + i)}`, 'ip-A')) allowed += 1;
    }
    expect(allowed).toBe(50);
  });

  it('clearLoginFailures(phone, ip) after 9 failures + 1 success leaves (phone, ip) at 0 and deletes the day key', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    for (let i = 0; i < 10; i++) expect(await s.reserveLoginAttempt(PHONE, 'ip-A')).toBe(true); // 9 failures + the success
    await s.clearLoginFailures(PHONE, 'ip-A');
    const keys = [...redis.dump.keys()];
    expect(keys.some((k) => k.startsWith(`sr_loginfail:pi:${NORM}:`))).toBe(false);
    expect(keys.some((k) => k.startsWith(`sr_loginfail:p:${NORM}:`))).toBe(false);
    // The per-IP hourly counter keeps counting (documented): it is not cleared.
    expect(keys.some((k) => k.startsWith('sr_loginfail:ip:'))).toBe(true);
    for (let i = 0; i < 10; i++) expect(await s.reserveLoginAttempt(PHONE, 'ip-A')).toBe(true);
  });

  it('clearLoginFailures(phone) alone (the reset path) unlocks a phone locked from many IPs', async () => {
    const { s } = await mkAuth();
    const ips = ['ip-A', 'ip-B', 'ip-C', 'ip-D'];
    for (let i = 0; i < 30; i++) await s.reserveLoginAttempt(PHONE, ips[i % 4]);
    expect(await s.reserveLoginAttempt(PHONE, 'ip-E')).toBe(false);
    await s.clearLoginFailures(PHONE);
    expect(await s.reserveLoginAttempt(PHONE, 'ip-E')).toBe(true);
  });

  it('never puts the raw IP in a key (hashed)', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    await s.reserveLoginAttempt(PHONE, '203.0.113.7');
    expect([...redis.dump.keys()].some((k) => k.includes('203.0.113.7'))).toBe(false);
  });
});

describe('tenant binding (fix 1, D6)', () => {
  it('a session carries the tenant and resolveSession returns THAT row', async () => {
    const { s, customers, db } = await mkAuth();
    await seedPartner(db, 'acme');
    await s.registerCustomer({ phone: PHONE, email: 'a@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto });
    // a sibling acme row for the same number (bot-only, no account)
    await customers.upsertOnFirstInbound('acme', NORM);
    const token = await s.createSession(NORM, 'default');
    expect(await s.getSession(token)).toBe(NORM);
    expect((await s.resolveSession(token))?.partnerId).toBe('default');
    expect((await s.resolveSession(token))?.passwordHash).toBeTruthy();
  });

  it('a pre-fix session record without partnerId resolves to nothing (forces re-login)', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    const token = 'a'.repeat(64);
    const { createHash } = await import('node:crypto');
    await redis.set(`sr_sess:${createHash('sha256').update(token).digest('hex')}`, JSON.stringify({ phone: NORM, createdAtMs: Date.now(), lastSeenMs: Date.now() }));
    expect(await s.resolveSession(token)).toBeNull();
  });

  it('login resolves exactly one account-bearing row and fails CLOSED when the phone has accounts under two partners', async () => {
    const { s, customers, db } = await mkAuth();
    await seedPartner(db, 'acme');
    const c = await s.registerCustomer({ phone: PHONE, email: 'a@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto });
    expect(c.partnerId).toBe('default');
    expect((await s.verifyCustomerPassword(PHONE, 'correct horse battery'))?.partnerId).toBe('default');
    // A second account-bearing row appears under acme (e.g. an admin import) ⇒ ambiguous ⇒ null, never a guess.
    await customers.saveCustomer({ ...c, partnerId: 'acme' });
    expect(await s.verifyCustomerPassword(PHONE, 'correct horse battery')).toBeNull();
    expect(await s.markPhoneVerified(PHONE)).toBeNull();
    expect(await s.setPassword(PHONE, 'another good one!!', { pwnedCheck: neverPwned() })).toBeNull();
  });

  it('registerCustomer attaches to the single existing row (any tenant) and refuses when the phone exists under two', async () => {
    const { s, customers, db } = await mkAuth();
    await seedPartner(db, 'acme');
    await customers.upsertOnFirstInbound('acme', NORM); // bot-only acme customer registers on the portal
    const c = await s.registerCustomer({ phone: PHONE, email: 'a@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto });
    expect(c.partnerId).toBe('acme');
    expect(await customers.getCustomer('default', NORM)).toBeNull(); // no stray default row
    await customers.upsertOnFirstInbound('default', '15550102031');
    await customers.upsertOnFirstInbound('acme', '15550102031');
    await expect(
      s.registerCustomer({ phone: '15550102031', email: 'b@example.com', password: 'correct horse battery' }, { pwnedCheck: neverPwned(), cryptoProvider: crypto }),
    ).rejects.toBeInstanceOf(CustomerInputError);
  });
});

// Program-Fix 20 (F65): the per-phone revoke index holds sha256(token), never the
// raw token, and carries a TTL. Revoke-all still sweeps the pre-fix raw-token
// index (`sr_sess_idx:`), whose sessions survive the deploy (same record key).
describe('customer session index holds hashes (fix 20)', () => {
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  /** A pre-fix session: a live sr_sess:<sha> record indexed by its RAW token. */
  async function seedLegacySession(redis: ReturnType<typeof fakeRedis>, ts: number): Promise<string> {
    const t = randomBytes(32).toString('hex');
    await redis.set(
      `sr_sess:${sha(t)}`,
      JSON.stringify({ phone: NORM, partnerId: 'default', createdAtMs: ts, lastSeenMs: ts }),
    );
    await redis.sadd(`sr_sess_idx:${NORM}`, t);
    return t;
  }

  it('indexes sha256(token) under sr_sess_ix:<phone> with a TTL, and stores the raw token nowhere', async () => {
    const redis = fakeRedis();
    const expire = vi.spyOn(redis, 'expire');
    const { s } = await mkAuth(redis);
    const token = await s.createSession(NORM, 'default');
    expect(await s.getSession(token)).toBe(NORM);
    expect(redis.sets.get(`sr_sess_ix:${NORM}`)?.has(sha(token))).toBe(true);
    expect(redis.sets.has(`sr_sess_idx:${NORM}`)).toBe(false);
    for (const [k, v] of redis.dump) {
      expect(k).not.toContain(token);
      expect(v).not.toContain(token);
    }
    for (const [k, members] of redis.sets) {
      expect(k).not.toContain(token);
      for (const m of members) expect(m).not.toContain(token);
    }
    expect(expire).toHaveBeenCalledWith(`sr_sess_ix:${NORM}`, 12 * 60 * 60);
  });

  it('indexes the session BEFORE writing its record (a failed index write never leaves an unrevocable session)', async () => {
    const redis = fakeRedis();
    const order: string[] = [];
    const set = redis.set.bind(redis);
    const sadd = redis.sadd.bind(redis);
    redis.set = async (k, v, o) => { order.push(`set:${k.split(':')[0]}`); return set(k, v, o); };
    redis.sadd = async (k, m) => { order.push(`sadd:${k.split(':')[0]}`); return sadd(k, m); };
    const { s } = await mkAuth(redis);
    await s.createSession(NORM, 'default');
    expect(order).toEqual(['sadd:sr_sess_ix', 'set:sr_sess']);
  });

  it('deleteSession removes the hash from the new index', async () => {
    const redis = fakeRedis();
    const { s } = await mkAuth(redis);
    const token = await s.createSession(NORM, 'default');
    expect(redis.sets.get(`sr_sess_ix:${NORM}`)?.size).toBe(1);
    await s.deleteSession(token);
    expect(redis.sets.get(`sr_sess_ix:${NORM}`)?.size).toBe(0);
  });

  it('deleteSession on a pre-fix session removes its raw token from the legacy index', async () => {
    const now = 1_000_000;
    const redis = fakeRedis();
    const { s } = await mkAuth(redis, () => now);
    const legacy = await seedLegacySession(redis, now);
    expect(await s.getSession(legacy)).toBe(NORM);
    await s.deleteSession(legacy);
    expect(await s.getSession(legacy)).toBeNull();
    expect(redis.sets.get(`sr_sess_idx:${NORM}`)?.size ?? 0).toBe(0);
  });

  it('deleteAllSessions revokes new AND pre-fix sessions, and drops both index sets', async () => {
    const now = 1_000_000;
    const redis = fakeRedis();
    const { s } = await mkAuth(redis, () => now);
    const legacy = await seedLegacySession(redis, now);
    const fresh = await s.createSession(NORM, 'default');
    const other = await s.createSession('19998887777', 'default');
    expect(await s.getSession(legacy)).toBe(NORM); // precondition: live before revoke
    expect(await s.getSession(fresh)).toBe(NORM);

    await s.deleteAllSessions(NORM);

    expect(await s.getSession(legacy)).toBeNull();
    expect(await s.getSession(fresh)).toBeNull();
    expect(redis.sets.has(`sr_sess_idx:${NORM}`)).toBe(false);
    expect(redis.sets.has(`sr_sess_ix:${NORM}`)).toBe(false);
    expect(await s.getSession(other)).toBe('19998887777');
  });

  it('setPassword revokes new AND pre-fix sessions', async () => {
    const now = Date.now();
    const redis = fakeRedis();
    const { s } = await mkAuth(redis, () => now);
    await s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'correct horse battery' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    const legacy = await seedLegacySession(redis, now);
    const fresh = await s.createSession(NORM, 'default');
    expect(await s.getSession(legacy)).toBe(NORM);
    expect(await s.getSession(fresh)).toBe(NORM);

    expect(await s.setPassword(PHONE, 'another good one!!', { pwnedCheck: neverPwned() })).not.toBeNull();

    expect(await s.getSession(legacy)).toBeNull();
    expect(await s.getSession(fresh)).toBeNull();
    expect(redis.sets.has(`sr_sess_idx:${NORM}`)).toBe(false);
    expect(redis.sets.has(`sr_sess_ix:${NORM}`)).toBe(false);
  });
});

// Program-Fix 20 review follow-up: a password change invalidates every session
// minted before it, even one no index knows about (an old-build reset during a
// rolling release / Skew Protection / rollback, or a lost index).
describe('resolveSession rejects sessions older than the last password change (fix 20)', () => {
  async function registered(now: () => number) {
    const redis = fakeRedis();
    const ctx = await mkAuth(redis, now);
    await ctx.s.registerCustomer(
      { phone: PHONE, email: 'a@example.com', password: 'correct horse battery' },
      { pwnedCheck: neverPwned(), cryptoProvider: crypto },
    );
    return { ...ctx, redis };
  }

  it('a session created BEFORE a password update is rejected, even if no index points at it', async () => {
    let t = Date.parse('2026-09-01T10:00:00.000Z');
    const { s, customers } = await registered(() => t);
    t += 60_000;
    const token = await s.createSession(NORM, 'default');
    expect((await s.resolveSession(token))?.senderPhone).toBe(NORM); // precondition
    // An old build resets the password without seeing the new index.
    t += 60_000;
    const row = (await customers.getCustomer('default', NORM))!;
    await customers.saveCustomer({ ...row, passwordUpdatedAt: new Date(t).toISOString() });
    expect(await s.resolveSession(token)).toBeNull();
  });

  it('a session created AFTER the password update is accepted', async () => {
    let t = Date.parse('2026-09-01T10:00:00.000Z');
    const { s } = await registered(() => t);
    t += 60_000;
    expect(await s.setPassword(PHONE, 'another good one!!', { pwnedCheck: neverPwned() })).not.toBeNull();
    t += 1;
    const token = await s.createSession(NORM, 'default');
    expect((await s.resolveSession(token))?.senderPhone).toBe(NORM);
  });

  it('a session minted in the same millisecond as the update is accepted (strictly-after rule)', async () => {
    const t = Date.parse('2026-09-01T10:00:00.000Z');
    const { s } = await registered(() => t);
    const token = await s.createSession(NORM, 'default');
    expect((await s.resolveSession(token))?.senderPhone).toBe(NORM);
  });

  it('a lazy scrypt→Argon2 rehash at login does NOT sign out the other devices (same password)', async () => {
    let t = Date.parse('2026-09-01T10:00:00.000Z');
    const { s, customers } = await registered(() => t);
    const row = (await customers.getCustomer('default', NORM))!;
    await customers.saveCustomer({ ...row, passwordHash: legacyScryptHash('legacy pass 123') });
    t += 60_000;
    const otherDevice = await s.createSession(NORM, 'default');
    t += 60_000;
    const upgraded = await s.verifyCustomerPassword(PHONE, 'legacy pass 123');
    expect(upgraded?.passwordHash?.startsWith('$argon2id$')).toBe(true); // precondition: rehash ran
    expect((await s.resolveSession(otherDevice))?.senderPhone).toBe(NORM);
  });

  it('a row with no passwordUpdatedAt never rejects', async () => {
    let t = Date.parse('2026-09-01T10:00:00.000Z');
    const { s, customers } = await registered(() => t);
    const row = (await customers.getCustomer('default', NORM))!;
    await customers.saveCustomer({ ...row, passwordUpdatedAt: undefined });
    expect((await customers.getCustomer('default', NORM))?.passwordUpdatedAt).toBeUndefined(); // precondition
    t -= 60 * 60_000; // the session is even OLDER than the register time: still no rejection without the field
    const token = await s.createSession(NORM, 'default');
    expect((await s.resolveSession(token))?.senderPhone).toBe(NORM);
  });
});

describe('lazy rehash is a single-column compare-and-set (Program-Fix 17a)', () => {
  async function legacyRow() {
    const redis = fakeRedis();
    const db = await freshDb();
    const customers = createCustomerStore(db, createStore(fakeRedis(), db));
    const legacy = legacyScryptHash('legacy secret pw');
    await customers.saveCustomer({
      senderPhone: NORM,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'not_started',
      senderCountry: 'US',
      partnerId: 'default',
      passwordHash: legacy,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    return { redis, db, customers, legacy };
  }

  it('reset between verify and rehash is not reverted (and a concurrent KYC write survives)', async () => {
    const { redis, customers } = await legacyRow();
    const s0 = createCustomerAuthStore(redis, customers);
    // The concurrent writer: a password reset + a KYC update that land after the
    // verify read the row and before the rehash writes.
    const racing = {
      ...customers,
      async upgradePasswordHash(...args: Parameters<typeof customers.upgradePasswordHash>) {
        await s0.setPassword(PHONE, 'brand new password', { pwnedCheck: neverPwned() });
        const fresh = (await customers.getCustomer('default', NORM))!;
        await customers.saveCustomer({ ...fresh, kycStatus: 'pending' });
        return customers.upgradePasswordHash(...args);
      },
    };
    const saveSpy = vi.spyOn(racing, 'saveCustomer');
    const s = createCustomerAuthStore(redis, racing);
    const c = await s.verifyCustomerPassword(PHONE, 'legacy secret pw');
    expect(c).not.toBeNull(); // the verify itself succeeded
    expect(saveSpy).not.toHaveBeenCalled(); // no whole-row upsert on the rehash path
    const persisted = (await customers.getCustomer('default', NORM))!;
    expect(await verifyPassword('brand new password', persisted.passwordHash!)).toBe(true);
    expect(await verifyPassword('legacy secret pw', persisted.passwordHash!)).toBe(false);
    expect(persisted.kycStatus).toBe('pending');
  });

  it('upgradePasswordHash (repo): true on a match, false on a stale old hash, tenant-keyed', async () => {
    const { customers, legacy } = await legacyRow();
    expect(await customers.upgradePasswordHash('default', NORM, 'stale', 'H1')).toBe(false);
    expect(await customers.upgradePasswordHash('acme', NORM, legacy, 'H1')).toBe(false); // other tenant: no row
    expect((await customers.getCustomer('default', NORM))!.passwordHash).toBe(legacy);
    expect(await customers.upgradePasswordHash('default', NORM, legacy, 'H1')).toBe(true);
    expect((await customers.getCustomer('default', NORM))!.passwordHash).toBe('H1');
  });
});
