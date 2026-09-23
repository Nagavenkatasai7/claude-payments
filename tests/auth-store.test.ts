import { describe, it, expect, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createAuthStore } from '@/lib/auth-store';
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
    expect(order).toEqual(['sadd:staff_sess_ix', 'set:staff_sess']);
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
