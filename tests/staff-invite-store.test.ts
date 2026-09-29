import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createStaffInviteStore, hashInviteToken, INVITE_TTL_SEC, MAX_PENDING_INVITES } from '@/lib/staff-invite-store';

// UI redesign M3-8, Task 8.1: the staff invite is a 72 h, single-use capability in Redis. Only the
// token's SHA-256 is stored; consumption is atomic (getdel); every read is tenant-scoped.
const base = { partnerId: 'pa', username: 'pa-new', name: 'New', role: 'agent' as const, invitedBy: 'pa-admin' };

describe('staff invite store', () => {
  it('issues a 256-bit token, stores only its hash, expires in 72 h', async () => {
    const redis = fakeRedis();
    const now = new Date();
    const r = await createStaffInviteStore(redis, () => now).issue(base);
    if ('error' in r) throw new Error('unexpected');
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.hash).toBe(hashInviteToken(r.token));
    expect([...redis.dump.keys()].some((k) => k.includes(r.token))).toBe(false);
    expect([...redis.dump.values()].some((v) => v.includes(r.token))).toBe(false);
    for (const [k, members] of redis.sets) {
      expect(k.includes(r.token)).toBe(false);
      for (const m of members) expect(m.includes(r.token)).toBe(false);
    }
    expect(redis.dump.has(`staffinvite:${hashInviteToken(r.token)}`)).toBe(true);
    expect(Date.parse(r.expiresAt) - now.getTime()).toBe(72 * 3600 * 1000);
    expect(INVITE_TTL_SEC).toBe(72 * 3600);
  });
  it('hashInviteToken is sha256 hex', () => {
    expect(hashInviteToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('the stored record carries no email and no token', async () => {
    const redis = fakeRedis();
    const r = await createStaffInviteStore(redis).issue(base);
    if ('error' in r) throw new Error();
    const stored = JSON.parse(redis.dump.get(`staffinvite:${r.hash}`)!);
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'expiresAt', 'invitedBy', 'name', 'partnerId', 'role', 'username']);
  });
  it('peek returns the invite without consuming it', async () => {
    const s = createStaffInviteStore(fakeRedis());
    const r = await s.issue(base);
    if ('error' in r) throw new Error();
    expect(await s.peek(r.token)).toMatchObject({ username: 'pa-new', partnerId: 'pa', role: 'agent', invitedBy: 'pa-admin' });
    expect(await s.peek(r.token)).not.toBeNull();
  });
  it('consume is single-use', async () => {
    const s = createStaffInviteStore(fakeRedis());
    const r = await s.issue(base);
    if ('error' in r) throw new Error();
    expect(await s.consume(r.token)).toMatchObject({ username: 'pa-new', partnerId: 'pa' });
    expect(await s.consume(r.token)).toBeNull();
    expect(await s.peek(r.token)).toBeNull();
    expect(await s.listForPartner('pa')).toEqual([]);
  });
  it('expired (clock past expiresAt, key not yet evicted) ⇒ null', async () => {
    const redis = fakeRedis();
    let t = new Date();
    const s = createStaffInviteStore(redis, () => t);
    const r = await s.issue(base);
    if ('error' in r) throw new Error();
    t = new Date(t.getTime() + 72 * 3600 * 1000 + 1);
    expect(await s.peek(r.token)).toBeNull();
    expect(await s.consume(r.token)).toBeNull();
  });
  it('listForPartner: the tenant only, id = first 12 hex of the hash, expired and missing members pruned', async () => {
    const redis = fakeRedis();
    let t = new Date();
    const s = createStaffInviteStore(redis, () => t);
    const a = await s.issue(base);
    const b = await s.issue({ ...base, partnerId: 'pb', username: 'pb-new' });
    if ('error' in a || 'error' in b) throw new Error();
    const list = await s.listForPartner('pa');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.hash.slice(0, 12), username: 'pa-new', partnerId: 'pa' });
    expect(JSON.stringify(list)).not.toContain(a.token);
    // A member whose record is gone (evicted) is pruned from the index.
    await redis.del(`staffinvite:${a.hash}`);
    expect(await s.listForPartner('pa')).toEqual([]);
    expect(redis.sets.get('staffinvites:pa')?.size ?? 0).toBe(0);
    // A record past its expiry is pruned too.
    t = new Date(t.getTime() + 72 * 3600 * 1000 + 1);
    expect(await s.listForPartner('pb')).toEqual([]);
    expect(redis.sets.get('staffinvites:pb')?.size ?? 0).toBe(0);
  });
  it('listForPartner of an empty or blank tenant is empty', async () => {
    const s = createStaffInviteStore(fakeRedis());
    await s.issue(base);
    expect(await s.listForPartner('')).toEqual([]);
  });
  it('revoke is tenant-scoped', async () => {
    const s = createStaffInviteStore(fakeRedis());
    const r = await s.issue(base);
    if ('error' in r) throw new Error();
    const [inv] = await s.listForPartner('pa');
    expect(await s.revoke('pb', inv.id)).toBe(false);
    expect(await s.peek(r.token)).not.toBeNull();
    expect(await s.revoke('pa', inv.id)).toBe(true);
    expect(await s.peek(r.token)).toBeNull();
    expect(await s.revoke('pa', inv.id)).toBe(false);
  });
  it('revoke refuses a malformed id (never a prefix scan on "" or junk)', async () => {
    const s = createStaffInviteStore(fakeRedis());
    const r = await s.issue(base);
    if ('error' in r) throw new Error();
    for (const id of ['', 'a', r.hash.slice(0, 11), r.hash.slice(0, 13), r.hash, 'ZZZZZZZZZZZZ']) {
      expect(await s.revoke('pa', id)).toBe(false);
    }
    expect(await s.peek(r.token)).not.toBeNull();
  });
  it(`at most ${MAX_PENDING_INVITES} pending per partner`, async () => {
    const s = createStaffInviteStore(fakeRedis());
    expect(MAX_PENDING_INVITES).toBe(20);
    for (let i = 0; i < 20; i++) await s.issue({ ...base, username: `u${i}` });
    expect(await s.issue({ ...base, username: 'u21' })).toEqual({ error: 'too_many' });
    // Another tenant is unaffected.
    expect('error' in (await s.issue({ ...base, partnerId: 'pb' }))).toBe(false);
  });
  it('expired invites do not count toward the cap', async () => {
    let t = new Date();
    const s = createStaffInviteStore(fakeRedis(), () => t);
    for (let i = 0; i < 20; i++) await s.issue({ ...base, username: `u${i}` });
    t = new Date(t.getTime() + 72 * 3600 * 1000 + 1);
    expect('error' in (await s.issue({ ...base, username: 'u21' }))).toBe(false);
  });
  it('garbage tokens are null without throwing', async () => {
    const s = createStaffInviteStore(fakeRedis());
    for (const t of ['', 'x', 'a'.repeat(5000), '../../etc', 'a'.repeat(42) + '=']) {
      expect(await s.peek(t)).toBeNull();
      expect(await s.consume(t)).toBeNull();
    }
  });
  it('M3-21: inviterScope round-trips only as "platform"; absent (or anything else) reads as tenant-issued', async () => {
    const redis = fakeRedis();
    const store = createStaffInviteStore(redis);
    const a = await store.issue({ partnerId: 'pa', username: 'pa-plat', name: 'P', role: 'admin', invitedBy: 'root', inviterScope: 'platform' });
    const b = await store.issue({ partnerId: 'pa', username: 'pa-ten', name: 'T', role: 'admin', invitedBy: 'pa-owner' });
    if ('error' in a || 'error' in b) throw new Error('issue refused');
    expect((await store.peek(a.token))?.inviterScope).toBe('platform');
    expect(await store.peek(b.token)).not.toHaveProperty('inviterScope');
    const raw = JSON.parse((await redis.get(`staffinvite:${b.hash}`))!);
    await redis.set(`staffinvite:${b.hash}`, JSON.stringify({ ...raw, inviterScope: 'PLATFORM' }));
    expect(await store.peek(b.token)).not.toHaveProperty('inviterScope');
  });

  it('a corrupt stored record reads as null', async () => {
    const redis = fakeRedis();
    const s = createStaffInviteStore(redis);
    const r = await s.issue(base);
    if ('error' in r) throw new Error();
    redis.dump.set(`staffinvite:${r.hash}`, '{not json');
    expect(await s.peek(r.token)).toBeNull();
    expect(await s.listForPartner('pa')).toEqual([]);
  });
});
