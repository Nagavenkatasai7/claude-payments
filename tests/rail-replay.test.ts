import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import type { RedisLike } from '@/lib/store';
import { railNonceSeen, markRailNonce, RAIL_NONCE_TTL_SEC } from '@/lib/rail-replay';

// Program-Fix 29: check-then-mark replay guard for v2 rail signatures.
// GET before handling, SET only after the handling succeeded; any Redis
// failure is 'unavailable' (fail-open — the time window still applies).

function throwingRedis(): RedisLike {
  const boom = async () => { throw new Error('redis down'); };
  return new Proxy({} as RedisLike, { get: () => boom });
}

function hangingRedis(): RedisLike {
  const never = () => new Promise<never>(() => {});
  return new Proxy({} as RedisLike, { get: () => never });
}

describe('rail-replay', () => {
  it('a fresh nonce is fresh; after mark it is seen', async () => {
    const r = fakeRedis();
    expect(await railNonceSeen('n1', r)).toBe('fresh');
    await markRailNonce('n1', r);
    expect(await railNonceSeen('n1', r)).toBe('seen');
    expect(await railNonceSeen('n2', r)).toBe('fresh');
  });

  it('marks under railsig:<nonce> with a TTL above twice the window', async () => {
    expect(RAIL_NONCE_TTL_SEC).toBeGreaterThan(600);
    const calls: unknown[][] = [];
    const r = fakeRedis();
    const spy = new Proxy(r, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === 'set') return (...a: unknown[]) => { calls.push(a); return (v as (...x: unknown[]) => unknown).apply(target, a); };
        return v;
      },
    }) as RedisLike;
    await markRailNonce('abc', spy);
    expect(calls[0][0]).toBe('railsig:abc');
    expect(calls[0][2]).toEqual({ ex: RAIL_NONCE_TTL_SEC });
  });

  it('a Redis error is unavailable (fail-open) and mark never throws', async () => {
    expect(await railNonceSeen('n1', throwingRedis())).toBe('unavailable');
    await expect(markRailNonce('n1', throwingRedis())).resolves.toBeUndefined();
  });

  it('a hung Redis resolves unavailable within the deadline', async () => {
    const t0 = Date.now();
    expect(await railNonceSeen('n1', hangingRedis(), 50)).toBe('unavailable');
    await expect(markRailNonce('n1', hangingRedis(), 50)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('no mark when the handler throws: the caller marks only after success', async () => {
    const r = fakeRedis();
    const handle = async (fail: boolean) => {
      if ((await railNonceSeen('n9', r)) === 'seen') return 'duplicate';
      if (fail) throw new Error('db down');
      await markRailNonce('n9', r);
      return 'ok';
    };
    await expect(handle(true)).rejects.toThrow('db down');
    expect(await railNonceSeen('n9', r)).toBe('fresh');
    expect(await handle(false)).toBe('ok');
    expect(await handle(false)).toBe('duplicate');
  });
});
