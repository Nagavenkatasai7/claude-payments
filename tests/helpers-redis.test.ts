import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';

describe('fakeRedis atomic operations', () => {
  it('incr starts at 1 and increments', async () => {
    const r = fakeRedis();
    expect(await r.incr('c')).toBe(1);
    expect(await r.incr('c')).toBe(2);
  });

  it('sadd is idempotent and smembers lists members', async () => {
    const r = fakeRedis();
    await r.sadd('s', 'a');
    await r.sadd('s', 'b');
    await r.sadd('s', 'a');
    expect((await r.smembers('s')).sort()).toEqual(['a', 'b']);
  });

  it('srem removes a member', async () => {
    const r = fakeRedis();
    await r.sadd('s', 'a');
    await r.sadd('s', 'b');
    await r.srem('s', 'a');
    expect(await r.smembers('s')).toEqual(['b']);
  });

  it('del removes a key and a set', async () => {
    const r = fakeRedis();
    await r.set('k', 'v');
    await r.sadd('s', 'a');
    await r.del('k');
    await r.del('s');
    expect(await r.get('k')).toBeNull();
    expect(await r.smembers('s')).toEqual([]);
  });

  it('smembers returns empty array for an unknown set', async () => {
    expect(await fakeRedis().smembers('nope')).toEqual([]);
  });
});

describe('fakeRedis hashes', () => {
  it('hset writes a field and hget reads it back', async () => {
    const r = fakeRedis();
    await r.hset('recipients:1', { '919876543210': '{"name":"Mom"}' });
    expect(await r.hget('recipients:1', '919876543210')).toBe('{"name":"Mom"}');
  });

  it('hgetall returns every field as an object', async () => {
    const r = fakeRedis();
    await r.hset('recipients:1', { '919876543210': 'a', '919999999999': 'b' });
    const all = await r.hgetall('recipients:1');
    expect(all).toEqual({ '919876543210': 'a', '919999999999': 'b' });
  });

  it('hgetall returns {} for a missing key', async () => {
    expect(await fakeRedis().hgetall('recipients:nobody')).toEqual({});
  });

  it('hdel removes a field', async () => {
    const r = fakeRedis();
    await r.hset('h', { a: '1', b: '2' });
    await r.hdel('h', 'a');
    expect(await r.hgetall('h')).toEqual({ b: '2' });
  });
});

describe('fakeRedis getdel', () => {
  it('returns the value and deletes it atomically', async () => {
    const r = fakeRedis();
    await r.set('k', 'v');
    expect(await r.getdel('k')).toBe('v');
    expect(await r.get('k')).toBeNull();
  });

  it('returns null for a missing key', async () => {
    expect(await fakeRedis().getdel('nope')).toBeNull();
  });
});

describe('fakeRedis exists', () => {
  it('returns 1 when key is present, 0 when not', async () => {
    const r = fakeRedis();
    expect(await r.exists('k')).toBe(0);
    await r.set('k', 'v');
    expect(await r.exists('k')).toBe(1);
  });
});
