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
