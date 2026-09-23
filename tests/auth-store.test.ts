import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createAuthStore, type StaffLedger } from '@/lib/auth-store';
import { createStaffRepo } from '@/db/repos/staff-repo';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { fakeRedis } from './helpers';
import type { Staff } from '@/lib/types';

function staff(username: string, createdAt: string): Staff {
  return {
    username,
    name: username.toUpperCase(),
    role: 'agent',
    permissions: { canCancel: false, canResend: true, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt,
  };
}

describe('auth-store staff', () => {
  it('round-trips a staff member', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('priya', '2026-05-21T01:00:00.000Z'));
    const loaded = await s.getStaff('priya');
    expect(loaded?.name).toBe('PRIYA');
  });

  it('returns null for an unknown staff member', async () => {
    expect(await createAuthStore(fakeRedis()).getStaff('nobody')).toBeNull();
  });

  it('lists staff sorted by createdAt', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('b', '2026-05-21T03:00:00.000Z'));
    await s.saveStaff(staff('a', '2026-05-21T01:00:00.000Z'));
    expect((await s.listStaff()).map((x) => x.username)).toEqual(['a', 'b']);
  });

  it('deletes a staff member', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('a', '2026-05-21T01:00:00.000Z'));
    await s.deleteStaff('a');
    expect(await s.getStaff('a')).toBeNull();
    expect(await s.listStaff()).toHaveLength(0);
  });
});

describe('auth-store sessions', () => {
  it('creates a session and resolves it back to the username', async () => {
    const s = createAuthStore(fakeRedis());
    const token = await s.createSession('priya');
    expect(typeof token).toBe('string');
    expect(await s.getSessionUser(token)).toBe('priya');
  });

  it('returns null for an unknown session token', async () => {
    expect(await createAuthStore(fakeRedis()).getSessionUser('x')).toBeNull();
  });

  it('deletes a session', async () => {
    const s = createAuthStore(fakeRedis());
    const token = await s.createSession('priya');
    await s.deleteSession(token);
    expect(await s.getSessionUser(token)).toBeNull();
  });
});

describe('auth-store session reverse-index', () => {
  it('tracks tokens per user and lets deleteAllSessionsFor revoke them', async () => {
    const s = createAuthStore(fakeRedis());
    const t1 = await s.createSession('priya');
    const t2 = await s.createSession('priya');
    const tOther = await s.createSession('admin');

    await s.deleteAllSessionsFor('priya');

    expect(await s.getSessionUser(t1)).toBeNull();
    expect(await s.getSessionUser(t2)).toBeNull();
    expect(await s.getSessionUser(tOther)).toBe('admin');
  });

  it('deleteSession also removes the token from the reverse-index set', async () => {
    const s = createAuthStore(fakeRedis());
    const t = await s.createSession('priya');
    await s.deleteSession(t);
    // Subsequent deleteAllSessionsFor must be a no-op (no orphan keys).
    await s.deleteAllSessionsFor('priya');
    expect(await s.getSessionUser(t)).toBeNull();
  });

  it('deleteAllSessionsFor on an unknown user is a no-op', async () => {
    const s = createAuthStore(fakeRedis());
    await expect(s.deleteAllSessionsFor('nobody')).resolves.not.toThrow();
  });
});

// Program-Fix 20 (F57): Redis holds no usable bearer token. The record key is
// staff_sess:<sha256(token)>; the per-user index holds hashes; legacy plaintext
// `session:<token>` keys are never honoured, and revoke-all sweeps them too.
describe('auth-store sessions are stored only as hashes (fix 20)', () => {
  function everything(r: ReturnType<typeof fakeRedis>): string[] {
    const out: string[] = [];
    for (const [k, v] of r.dump) out.push(k, v);
    for (const [k, members] of r.sets) out.push(k, ...members);
    return out;
  }

  it('no Redis key, value or set member contains the raw token', async () => {
    const r = fakeRedis();
    const s = createAuthStore(r);
    const token = await s.createSession('priya');
    expect(await s.getSessionUser(token)).toBe('priya');
    const hash = createHash('sha256').update(token).digest('hex');
    for (const item of everything(r)) expect(item).not.toContain(token);
    expect(r.dump.get(`staff_sess:${hash}`)).toBe('priya');
    expect(r.sets.get('staff_sess_ix:priya')?.has(hash)).toBe(true);
  });

  it('arms a TTL on the per-user index on every add', async () => {
    const r = fakeRedis();
    const expire = vi.spyOn(r, 'expire');
    const s = createAuthStore(r);
    await s.createSession('priya');
    await s.createSession('priya');
    const calls = expire.mock.calls.filter(([k]) => k === 'staff_sess_ix:priya');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe(7 * 24 * 60 * 60);
  });

  it('indexes the session BEFORE writing its record (a failed index write never leaves an unrevocable session)', async () => {
    const r = fakeRedis();
    const order: string[] = [];
    const set = r.set.bind(r);
    const sadd = r.sadd.bind(r);
    r.set = async (k, v, o) => { order.push(`set:${k.split(':')[0]}`); return set(k, v, o); };
    r.sadd = async (k, m) => { order.push(`sadd:${k.split(':')[0]}`); return sadd(k, m); };
    await createAuthStore(r).createSession('priya');
    // Program-Fix 45 P1: the seen record is written before the session record,
    // so a live session record always has one (a missing one means legacy).
    expect(order).toEqual(['sadd:staff_sess_ix', 'set:staff_sess_seen', 'set:staff_sess']);
  });

  it('a legacy plaintext session:<token> key is never honoured', async () => {
    const r = fakeRedis();
    const t = randomBytes(32).toString('hex');
    await r.set(`session:${t}`, 'priya');
    expect(await createAuthStore(r).getSessionUser(t)).toBeNull();
  });

  it('deleteSession removes the hash record and its index member', async () => {
    const r = fakeRedis();
    const s = createAuthStore(r);
    const token = await s.createSession('priya');
    expect(r.sets.get('staff_sess_ix:priya')?.size).toBe(1);
    await s.deleteSession(token);
    expect(await s.getSessionUser(token)).toBeNull();
    expect(r.sets.get('staff_sess_ix:priya')?.size).toBe(0);
  });

  it('deleteSession on a legacy cookie also deletes the legacy plaintext key', async () => {
    const r = fakeRedis();
    const t = randomBytes(32).toString('hex');
    await r.set(`session:${t}`, 'priya');
    await createAuthStore(r).deleteSession(t);
    expect(r.dump.has(`session:${t}`)).toBe(false);
  });

  it('deleteAllSessionsFor revokes new sessions AND sweeps the legacy index + keys', async () => {
    const r = fakeRedis();
    const s = createAuthStore(r);
    const t1 = await s.createSession('priya');
    const t2 = await s.createSession('priya');
    const tOther = await s.createSession('admin');
    const legacy = randomBytes(32).toString('hex');
    await r.set(`session:${legacy}`, 'priya');
    await r.sadd('staff_sessions:priya', legacy);

    await s.deleteAllSessionsFor('priya');

    expect(await s.getSessionUser(t1)).toBeNull();
    expect(await s.getSessionUser(t2)).toBeNull();
    expect(r.dump.has(`session:${legacy}`)).toBe(false);
    expect(r.sets.has('staff_sessions:priya')).toBe(false);
    expect(r.sets.has('staff_sess_ix:priya')).toBe(false);
    for (const k of r.dump.keys()) expect(k.startsWith('staff_sess:') && r.dump.get(k) === 'priya').toBe(false);
    expect(await s.getSessionUser(tOther)).toBe('admin');
  });
});

describe('auth-store password hash compare-and-set (Program-Fix 17a)', () => {
  const base = (over: Partial<Staff> = {}): Staff => ({
    username: 'ops',
    name: 'Ops',
    role: 'agent',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'H-old',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('updatePasswordHash writes only when the stored hash still equals the expected one', async () => {
    const store = createAuthStore(fakeRedis());
    await store.saveStaff(base());
    expect(await store.updatePasswordHash('ops', 'H-old', 'H-new')).toBe(true);
    expect((await store.getStaff('ops'))!.passwordHash).toBe('H-new');
  });

  it('updatePasswordHash: a reset between verify and rehash is not reverted', async () => {
    const store = createAuthStore(fakeRedis());
    await store.saveStaff(base());
    // An admin reset lands after the login verified against H-old …
    await store.saveStaff(base({ passwordHash: 'H-reset' }));
    // … so the lazy rehash (expecting H-old) must not write.
    expect(await store.updatePasswordHash('ops', 'H-old', 'H-rehash')).toBe(false);
    expect((await store.getStaff('ops'))!.passwordHash).toBe('H-reset');
  });

  it('updatePasswordHash no-ops on a suspended or missing record', async () => {
    const redis = fakeRedis();
    const store = createAuthStore(redis);
    await store.saveStaff(base({ status: 'suspended' }));
    expect(await store.updatePasswordHash('ops', 'H-old', 'H-new')).toBe(false);
    expect((await store.getStaff('ops'))!.passwordHash).toBe('H-old');
    expect(await store.updatePasswordHash('ghost', 'x', 'y')).toBe(false);
    expect(redis.dump.has('staff:ghost')).toBe(false);
  });

  it('setPasswordHash works on a suspended record and does NOT reactivate it', async () => {
    const store = createAuthStore(fakeRedis());
    await store.saveStaff(base({ status: 'suspended' }));
    expect(await store.setPasswordHash('ops', 'H-old', 'H-new')).toBe(true);
    const got = (await store.getStaff('ops'))!;
    expect(got.passwordHash).toBe('H-new');
    expect(got.status).toBe('suspended');
  });

  it('setPasswordHash returns false on a stale expected hash or a missing record', async () => {
    const redis = fakeRedis();
    const store = createAuthStore(redis);
    await store.saveStaff(base({ passwordHash: 'H-current' }));
    expect(await store.setPasswordHash('ops', 'H-stale', 'H-new')).toBe(false);
    expect((await store.getStaff('ops'))!.passwordHash).toBe('H-current');
    expect(await store.setPasswordHash('ghost', 'x', 'y')).toBe(false);
    expect(redis.dump.has('staff:ghost')).toBe(false);
  });

  it('setPasswordHash changes only passwordHash (every other field survives)', async () => {
    const store = createAuthStore(fakeRedis());
    await store.saveStaff(base({ role: 'admin', lastLoginAt: '2026-09-01T00:00:00Z', partnerId: 'acme' }));
    await store.setPasswordHash('ops', 'H-old', 'H-new');
    expect(await store.getStaff('ops')).toEqual(
      base({ role: 'admin', lastLoginAt: '2026-09-01T00:00:00Z', partnerId: 'acme', passwordHash: 'H-new' }),
    );
  });
});

// Program-Fix 45 P1 (sec-11 / crypto-10): 30-minute idle and 12-hour absolute
// windows. `staff_sess:<h>` keeps holding the username (the previous build
// reads only that); the sibling `staff_sess_seen:<h>` = `createdAtMs:lastSeenMs`
// carries the windows, enforced in code. A session record with no seen record
// was minted by the previous build: it is adopted once and capped at 12 h.
describe('auth-store session windows (Program-Fix 45 P1)', () => {
  const MIN = 60 * 1000;
  const T0 = new Date('2030-01-01T00:00:00Z').getTime();
  const hashOf = (t: string) => createHash('sha256').update(t).digest('hex');

  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const r = fakeRedis();
    return { r, s: createAuthStore(r) };
  }
  afterEach(() => vi.useRealTimers());

  it('mints the session record with a 12 h TTL and a seen record that outlives it', async () => {
    const { r, s } = setup();
    const set = vi.spyOn(r, 'set');
    const token = await s.createSession('priya');
    const h = hashOf(token);
    const sess = set.mock.calls.find(([k]) => k === `staff_sess:${h}`);
    const seen = set.mock.calls.find(([k]) => k === `staff_sess_seen:${h}`);
    expect(sess?.[1]).toBe('priya');
    expect(sess?.[2]).toEqual({ ex: 12 * 60 * 60 });
    expect(seen?.[1]).toBe(`${T0}:${T0}`);
    expect((seen?.[2] as { ex: number }).ex).toBeGreaterThan(12 * 60 * 60);
  });

  it('stays valid while active, across more than 30 minutes in total', async () => {
    const { s } = setup();
    const token = await s.createSession('priya');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20 * MIN);
      expect(await s.getSessionUser(token)).toBe('priya');
    }
  });

  it('idle for more than 30 minutes returns null, and the next call stays null', async () => {
    const { r, s } = setup();
    const token = await s.createSession('priya');
    const h = hashOf(token);
    vi.advanceTimersByTime(31 * MIN);
    expect(await s.getSessionUser(token)).toBeNull();
    expect(await s.getSessionUser(token)).toBeNull();
    expect(r.dump.has(`staff_sess:${h}`)).toBe(false);
    expect(r.dump.has(`staff_sess_seen:${h}`)).toBe(false);
    expect(r.sets.get('staff_sess_ix:priya')?.has(h)).toBe(false);
  });

  it('refreshes the last-seen time at most once a minute, keeping the absolute window', async () => {
    const { r, s } = setup();
    const token = await s.createSession('priya');
    const h = hashOf(token);
    const set = vi.spyOn(r, 'set');
    vi.advanceTimersByTime(30 * 1000);
    await s.getSessionUser(token);
    expect(set.mock.calls.filter(([k]) => k === `staff_sess_seen:${h}`)).toHaveLength(0);
    vi.advanceTimersByTime(60 * 1000);
    await s.getSessionUser(token);
    const writes = set.mock.calls.filter(([k]) => k === `staff_sess_seen:${h}`);
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe(`${T0}:${T0 + 90 * 1000}`);
    // Re-armed to what is left of the absolute window plus the grace, never a
    // fresh 12 h: the first create armed 12 h + grace, this one 90 s less.
    expect((writes[0][2] as { ex: number }).ex).toBe(12 * 60 * 60 + 60 * 60 - 90);
  });

  it('absolute: an active session is valid through 12 h and refused after', async () => {
    const { s } = setup();
    const token = await s.createSession('priya');
    for (let i = 0; i < 48; i++) {
      vi.advanceTimersByTime(15 * MIN); // lands on exactly 12 h at the last step
      expect(await s.getSessionUser(token)).toBe('priya');
    }
    vi.advanceTimersByTime(MIN);
    expect(await s.getSessionUser(token)).toBeNull();
    expect(await s.getSessionUser(token)).toBeNull();
  });

  it('a session from the previous build (no seen record) is adopted once and capped at 12 h', async () => {
    const { r, s } = setup();
    const token = randomBytes(32).toString('hex');
    const h = hashOf(token);
    // Exactly what the previous build's createSession writes.
    await r.sadd('staff_sess_ix:priya', h);
    await r.set(`staff_sess:${h}`, 'priya', { ex: 7 * 24 * 60 * 60 });
    const expire = vi.spyOn(r, 'expire');
    expect(await s.getSessionUser(token)).toBe('priya');
    expect(expire).toHaveBeenCalledWith(`staff_sess:${h}`, 12 * 60 * 60);
    expect(r.dump.get(`staff_sess_seen:${h}`)).toBe(`${T0}:${T0}`);
    // From then on it is an ordinary session: idle and absolute both bite.
    vi.advanceTimersByTime(31 * MIN);
    expect(await s.getSessionUser(token)).toBeNull();
    expect(await s.getSessionUser(token)).toBeNull();
  });

  it('an unreadable seen record revokes the session instead of adopting it', async () => {
    const { r, s } = setup();
    const token = await s.createSession('priya');
    const h = hashOf(token);
    await r.set(`staff_sess_seen:${h}`, 'garbage');
    expect(await s.getSessionUser(token)).toBeNull();
    expect(r.dump.has(`staff_sess:${h}`)).toBe(false);
  });

  it('deleteSession and deleteAllSessionsFor also remove the seen records', async () => {
    const { r, s } = setup();
    const t1 = await s.createSession('priya');
    const t2 = await s.createSession('priya');
    await s.deleteSession(t1);
    expect(r.dump.has(`staff_sess_seen:${hashOf(t1)}`)).toBe(false);
    await s.deleteAllSessionsFor('priya');
    expect(r.dump.has(`staff_sess_seen:${hashOf(t2)}`)).toBe(false);
    expect([...r.dump.keys()].some((k) => k.startsWith('staff_sess'))).toBe(false);
  });
});

// ── Program-Fix 45 P5 (crypto-03): the staff ledger dual-write ──────────────
// Real Postgres (PGlite on the drizzle chain, migration 0022) beside the fake
// Redis. During the dual-write release a record EXISTS only while its Redis
// record exists (an old-build delete never resurrects) and the Postgres row can
// only RESTRICT it (an old-build suspend lands only in Redis, and a stale or
// edited row never grants). The seed admin is never locked out by the row.
describe('auth-store staff ledger dual-write (Program-Fix 45 P5)', () => {
  const SEED = 'owner';
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'p_acme');
    await seedPartner(db, 'p_other');
  });

  function setup(ledger?: StaffLedger) {
    const r = fakeRedis();
    const repo = createStaffRepo(db);
    const s = createAuthStore(r, { ledger: () => ledger ?? repo, seedName: () => SEED });
    return { r, repo, s };
  }

  /** A ledger whose named methods throw (a Neon blip), the rest real. */
  function failing(names: Array<keyof StaffLedger>): StaffLedger {
    const repo = createStaffRepo(db);
    return new Proxy(repo, {
      get(target, prop, recv) {
        if ((names as string[]).includes(prop as string)) {
          return async () => {
            throw new Error('ledger down');
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
  }

  const agent = (over: Partial<Staff> = {}): Staff => ({
    ...staff('priya', '2026-09-01T10:00:00.000Z'),
    permissions: { canCancel: true, canResend: true, canAssign: true, canRevealPii: true },
    ...over,
  });
  const seedAdmin = (over: Partial<Staff> = {}): Staff => ({
    ...staff(SEED, '2026-05-01T00:00:00.000Z'),
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    ...over,
  });

  it('saveStaff writes both stores', async () => {
    const { r, repo, s } = setup();
    await s.saveStaff(agent());
    expect(JSON.parse(r.dump.get('staff:priya')!).name).toBe('PRIYA');
    expect((await repo.get('priya'))?.name).toBe('PRIYA');
  });

  it('getStaff copies a Redis-only record into Postgres (lazy copy-on-read)', async () => {
    const { r, repo, s } = setup();
    await r.set('staff:priya', JSON.stringify(agent()));
    await r.sadd('staff:index', 'priya');
    expect((await s.getStaff('priya'))?.role).toBe('agent');
    expect((await repo.get('priya'))?.permissions).toEqual(agent().permissions);
  });

  it('copy-on-read never overwrites an existing row', async () => {
    const { r, repo, s } = setup();
    await repo.upsert(agent({ name: 'Ledger name', status: 'suspended' }));
    await r.set('staff:priya', JSON.stringify(agent()));
    await s.getStaff('priya');
    const row = await repo.get('priya');
    expect(row?.name).toBe('Ledger name');
    expect(row?.status).toBe('suspended');
  });

  it('a Redis suspend (the previous build) holds even when the row says active', async () => {
    const { r, s } = setup();
    await s.saveStaff(agent());
    await r.set('staff:priya', JSON.stringify(agent({ status: 'suspended' })));
    expect((await s.getStaff('priya'))?.status).toBe('suspended');
  });

  it('a row suspend holds even when Redis says active (most restrictive)', async () => {
    const { r, repo, s } = setup();
    await r.set('staff:priya', JSON.stringify(agent()));
    await repo.upsert(agent({ status: 'suspended' }));
    expect((await s.getStaff('priya'))?.status).toBe('suspended');
  });

  it('role takes the lower rank (support < agent < admin); a support result gets no permissions', async () => {
    const { r, repo, s } = setup();
    await r.set('staff:priya', JSON.stringify(agent({ role: 'admin' })));
    await repo.upsert(agent({ role: 'agent' }));
    expect((await s.getStaff('priya'))?.role).toBe('agent');
    await repo.upsert(agent({ role: 'support' }));
    const got = await s.getStaff('priya');
    expect(got?.role).toBe('support');
    expect(got?.permissions).toEqual({ canCancel: false, canResend: false, canAssign: false, canRevealPii: false });
  });

  it('permissions are the per-key AND of both stores (absent = false)', async () => {
    const { r, repo, s } = setup();
    await r.set('staff:priya', JSON.stringify(agent()));
    await repo.upsert(agent({ permissions: { canCancel: false, canResend: true, canAssign: true } }));
    expect((await s.getStaff('priya'))?.permissions).toEqual({
      canCancel: false,
      canResend: true,
      canAssign: true,
      canRevealPii: false,
    });
  });

  it('partner scope: a set value wins over unset; two different partners fail closed (suspended)', async () => {
    const { r, repo, s } = setup();
    await r.set('staff:priya', JSON.stringify(agent()));
    await repo.upsert(agent({ partnerId: 'p_acme' }));
    expect((await s.getStaff('priya'))?.partnerId).toBe('p_acme');
    await r.set('staff:priya', JSON.stringify(agent({ partnerId: 'p_other' })));
    expect((await s.getStaff('priya'))?.status).toBe('suspended');
  });

  it('password hash, name and timestamps come from Redis (the row hash is a mirror, not read)', async () => {
    const { r, repo, s } = setup();
    await repo.upsert(agent({ passwordHash: 'ledger-hash', name: 'Old' }));
    await r.set('staff:priya', JSON.stringify(agent({ passwordHash: 'redis-hash', lastLoginAt: '2026-09-20T00:00:00.000Z' })));
    const got = await s.getStaff('priya');
    expect(got?.passwordHash).toBe('redis-hash');
    expect(got?.name).toBe('PRIYA');
    expect(got?.lastLoginAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('a row with no Redis record does not exist (a previous-build delete never resurrects)', async () => {
    const { repo, s } = setup();
    await repo.upsert(agent());
    expect(await s.getStaff('priya')).toBeNull();
    expect(await s.listStaff()).toEqual([]);
  });

  it('listStaff walks the Redis index only, merging each record with its row', async () => {
    const { repo, s } = setup();
    await s.saveStaff(agent());
    await s.saveStaff(agent({ username: 'ravi', createdAt: '2026-09-02T00:00:00.000Z' }));
    await repo.upsert(agent({ username: 'ghost' }));
    await repo.upsert(agent({ status: 'suspended' }));
    const all = await s.listStaff();
    expect(all.map((x) => x.username)).toEqual(['priya', 'ravi']);
    expect(all[0].status).toBe('suspended');
  });

  it('listStaff copies Redis-only records into Postgres too', async () => {
    const { r, repo, s } = setup();
    await r.set('staff:ravi', JSON.stringify(agent({ username: 'ravi' })));
    await r.sadd('staff:index', 'ravi');
    await s.listStaff();
    expect(await repo.get('ravi')).not.toBeNull();
  });

  it('the seed admin is never restricted by its row (suspended, demoted or partner-scoped)', async () => {
    const { r, repo, s } = setup();
    await r.set(`staff:${SEED}`, JSON.stringify(seedAdmin()));
    await repo.upsert(seedAdmin({ status: 'suspended', role: 'support', partnerId: 'p_acme', permissions: { canCancel: false, canResend: false, canAssign: false } }));
    const got = await s.getStaff(SEED);
    expect(got).toEqual(seedAdmin());
  });

  it('the seed exemption needs the Redis record itself to be the platform-admin seed record', async () => {
    const { r, repo, s } = setup();
    // Same name, but Redis already says partner staff: an ordinary record, merged.
    await r.set(`staff:${SEED}`, JSON.stringify(seedAdmin({ partnerId: 'p_acme' })));
    await repo.upsert(seedAdmin({ partnerId: 'p_acme', status: 'suspended' }));
    expect((await s.getStaff(SEED))?.status).toBe('suspended');
  });

  it('a Redis flush with rows left behind: listStaff is empty, so the seed admin is re-seeded and signs in', async () => {
    const before = setup();
    await before.s.saveStaff(seedAdmin({ passwordHash: 'old-hash' }));
    await before.s.saveStaff(agent());
    // Flush: a brand-new Redis over the same database.
    const r = fakeRedis();
    const s = createAuthStore(r, { ledger: () => createStaffRepo(db), seedName: () => SEED });
    expect(await s.listStaff()).toEqual([]);
    await s.saveStaff(seedAdmin({ passwordHash: 'new-hash' }));
    const got = await s.getStaff(SEED);
    expect(got?.passwordHash).toBe('new-hash');
    expect(got?.status ?? 'active').toBe('active');
    expect((await createStaffRepo(db).get(SEED))?.passwordHash).toBe('new-hash');
  });

  it('a ledger read failure falls back to the Redis record (never signs anyone out)', async () => {
    const { r, s } = setup(failing(['getMany', 'insertIfMissing']));
    await r.set('staff:priya', JSON.stringify(agent()));
    await r.sadd('staff:index', 'priya');
    expect((await s.getStaff('priya'))?.role).toBe('agent');
    expect((await s.listStaff()).map((x) => x.username)).toEqual(['priya']);
  });

  it('a copy-on-read insert failure (e.g. a partner row missing) still returns the record', async () => {
    const { r, s } = setup();
    await r.set('staff:priya', JSON.stringify(agent({ partnerId: 'p_missing' })));
    expect((await s.getStaff('priya'))?.partnerId).toBe('p_missing');
  });

  it('saveStaff writes the row FIRST: a ledger failure throws and leaves Redis untouched', async () => {
    const { r, s } = setup(failing(['upsert']));
    await expect(s.saveStaff(agent())).rejects.toThrow();
    expect(r.dump.has('staff:priya')).toBe(false);
  });

  it('saveStaff with ledgerBestEffort still lands the Redis record when the ledger fails (the seed path)', async () => {
    const { r, s } = setup(failing(['upsert']));
    await s.saveStaff(agent(), { ledgerBestEffort: true });
    expect(r.dump.has('staff:priya')).toBe(true);
  });

  it('deleteStaff removes both; a ledger failure throws and leaves Redis untouched', async () => {
    const ok = setup();
    await ok.s.saveStaff(agent());
    await ok.s.deleteStaff('priya');
    expect(await ok.repo.get('priya')).toBeNull();
    expect(ok.r.dump.has('staff:priya')).toBe(false);

    const bad = setup(failing(['remove']));
    await bad.s.saveStaff(agent());
    await expect(bad.s.deleteStaff('priya')).rejects.toThrow();
    expect(bad.r.dump.has('staff:priya')).toBe(true);
  });

  it('recordLogin mirrors lastLoginAt, best-effort (a ledger failure never blocks a sign-in)', async () => {
    const ok = setup();
    await ok.s.saveStaff(agent());
    await ok.s.recordLogin('priya');
    expect((await ok.repo.get('priya'))?.lastLoginAt).toBe(JSON.parse(ok.r.dump.get('staff:priya')!).lastLoginAt);

    const bad = setup(failing(['setLastLogin']));
    await bad.s.saveStaff(agent());
    await expect(bad.s.recordLogin('priya')).resolves.toBeUndefined();
  });

  it('password writes mirror only after the Redis compare-and-set wins, best-effort', async () => {
    const { repo, s } = setup();
    await s.saveStaff(agent({ passwordHash: 'h1' }));
    expect(await s.setPasswordHash('priya', 'wrong', 'h2')).toBe(false);
    expect((await repo.get('priya'))?.passwordHash).toBe('h1');
    expect(await s.setPasswordHash('priya', 'h1', 'h2')).toBe(true);
    expect((await repo.get('priya'))?.passwordHash).toBe('h2');
    expect(await s.updatePasswordHash('priya', 'h2', 'h3')).toBe(true);
    expect((await repo.get('priya'))?.passwordHash).toBe('h3');

    const bad = setup(failing(['setPasswordHash']));
    await bad.s.saveStaff(agent({ passwordHash: 'h1' }));
    expect(await bad.s.setPasswordHash('priya', 'h1', 'h2')).toBe(true);
    expect(await bad.s.updatePasswordHash('priya', 'h2', 'h3')).toBe(true);
  });

  it('without a ledger the store is Redis-only, exactly as before', async () => {
    const r = fakeRedis();
    const s = createAuthStore(r);
    await s.saveStaff(agent());
    expect((await s.getStaff('priya'))?.role).toBe('agent');
    expect(await createStaffRepo(db).get('priya')).toBeNull();
  });
});
