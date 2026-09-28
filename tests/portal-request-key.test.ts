import { describe, it, expect, vi } from 'vitest';
import { fakeRedis } from './helpers';
import {
  newRequestKey,
  runOnce,
  BadRequestKeyError,
  RequestInFlightError,
} from '@/lib/portal-request-key';

// M2-2 Task 2.5: the request-key replay guard for non-money portal mutations.
// A double submit runs the effect once; a failed attempt frees the key (review L2).
const P = '14155550101';
const noSleep = { sleep: async () => {} };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('newRequestKey', () => {
  it('is 128-bit lowercase hex and unique', () => {
    const a = newRequestKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newRequestKey()).not.toBe(a);
  });
});

describe('runOnce', () => {
  it('two concurrent calls with the same key run fn ONCE and return the same value', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    const gate = deferred<void>();
    const fn = vi.fn(async () => { await gate.promise; return { kind: 'draft', draftId: 'd1' }; });
    const sleep = vi.fn(async () => { gate.resolve(); await new Promise((r) => setTimeout(r, 0)); });
    const first = runOnce(redis, 'send', 'pa', P, key, fn, 1800, { sleep });
    const second = runOnce(redis, 'send', 'pa', P, key, fn, 1800, { sleep });
    const [a, b] = await Promise.all([first, second]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ replayed: false, value: { kind: 'draft', draftId: 'd1' } });
    expect(b).toEqual({ replayed: true, value: { kind: 'draft', draftId: 'd1' } });
  });

  it('a later submit with the same key replays the stored value without running fn', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    const fn = vi.fn(async () => ({ kind: 'ok' }));
    await runOnce(redis, 'ticket', 'pa', P, key, fn, 1800, noSleep);
    expect(await runOnce(redis, 'ticket', 'pa', P, key, fn, 1800, noSleep)).toEqual({ replayed: true, value: { kind: 'ok' } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a different partner, phone or scope with the same key is independent', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    const fn = vi.fn(async () => ({ kind: 'ok' }));
    await runOnce(redis, 'send', 'pa', P, key, fn, 1800, noSleep);
    expect((await runOnce(redis, 'send', 'pb', P, key, fn, 1800, noSleep)).replayed).toBe(false);
    expect((await runOnce(redis, 'send', 'pa', '14155550199', key, fn, 1800, noSleep)).replayed).toBe(false);
    expect((await runOnce(redis, 'recipient', 'pa', P, key, fn, 1800, noSleep)).replayed).toBe(false);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('the phone is normalised: "+1 415…" and "1415…" share a key', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    const fn = vi.fn(async () => ({ kind: 'ok' }));
    await runOnce(redis, 'send', 'pa', '+1 415 555 0101', key, fn, 1800, noSleep);
    expect((await runOnce(redis, 'send', 'pa', P, key, fn, 1800, noSleep)).replayed).toBe(true);
  });

  it('a malformed request key throws BadRequestKeyError before touching Redis', async () => {
    const redis = fakeRedis();
    const fn = vi.fn(async () => ({ kind: 'ok' }));
    for (const bad of ['', 'abc', 'A'.repeat(32), 'g'.repeat(32), `${'a'.repeat(32)}\n`, 'a'.repeat(33)]) {
      await expect(runOnce(redis, 'send', 'pa', P, bad, fn, 1800, noSleep)).rejects.toBeInstanceOf(BadRequestKeyError);
    }
    expect(fn).not.toHaveBeenCalled();
    expect(redis.dump.size).toBe(0);
  });

  it('refuses a malformed scope, an empty partner or an invalid phone (programmer errors)', async () => {
    const redis = fakeRedis();
    const fn = vi.fn(async () => ({ kind: 'ok' }));
    const key = newRequestKey();
    await expect(runOnce(redis, 'a:b', 'pa', P, key, fn)).rejects.toThrow();
    await expect(runOnce(redis, '', 'pa', P, key, fn)).rejects.toThrow();
    await expect(runOnce(redis, 'send', '', P, key, fn)).rejects.toThrow();
    await expect(runOnce(redis, 'send', 'pa', '12', key, fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('when fn throws, the claim is deleted and an honest retry runs fn again (review L2)', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ kind: 'ok' });
    await expect(runOnce(redis, 'send', 'pa', P, key, fn, 1800, noSleep)).rejects.toThrow('boom');
    expect(redis.dump.size).toBe(0);
    expect(await runOnce(redis, 'send', 'pa', P, key, fn, 1800, noSleep)).toEqual({ replayed: false, value: { kind: 'ok' } });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a loser whose winner is still running gets RequestInFlightError after the polls', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    const gate = deferred<{ kind: string }>();
    const winner = runOnce(redis, 'send', 'pa', P, key, () => gate.promise, 1800, noSleep);
    const sleep = vi.fn(async () => {});
    await expect(runOnce(redis, 'send', 'pa', P, key, async () => ({ kind: 'second' }), 1800, { sleep }))
      .rejects.toBeInstanceOf(RequestInFlightError);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(200);
    gate.resolve({ kind: 'first' });
    expect((await winner).value).toEqual({ kind: 'first' });
  });

  it('claims with SET NX and the TTL; the key holds no phone, partner or request key in clear', async () => {
    const base = fakeRedis();
    const sets: Array<[string, { ex?: number; nx?: boolean } | undefined]> = [];
    const redis = { ...base, async set(k: string, v: string, o?: { ex?: number; nx?: boolean }) { sets.push([k, o]); return base.set(k, v, o); } };
    const key = newRequestKey();
    await runOnce(redis, 'send', 'partner-alpha', P, key, async () => ({ kind: 'ok' }), 900, noSleep);
    expect(sets[0][1]).toEqual({ nx: true, ex: 900 });
    expect(sets[1][1]).toEqual({ ex: 900 });
    expect(sets[0][0]).toMatch(/^preq:send:[0-9a-f]{64}$/);
    for (const k of base.dump.keys()) {
      expect(k).not.toContain(P);
      expect(k).not.toContain('partner-alpha');
      expect(k).not.toContain(key);
    }
  });

  it('a void fn round-trips (value undefined on replay too)', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    const fn = vi.fn(async () => {});
    expect(await runOnce(redis, 'noop', 'pa', P, key, fn, 1800, noSleep)).toEqual({ replayed: false, value: undefined });
    expect(await runOnce(redis, 'noop', 'pa', P, key, fn, 1800, noSleep)).toEqual({ replayed: true, value: undefined });
  });

  it('a corrupt stored value is treated as in flight, never as a replay', async () => {
    const redis = fakeRedis();
    const key = newRequestKey();
    await runOnce(redis, 'send', 'pa', P, key, async () => ({ kind: 'ok' }), 1800, noSleep);
    for (const k of redis.dump.keys()) redis.dump.set(k, '{nope');
    await expect(runOnce(redis, 'send', 'pa', P, key, async () => ({ kind: 'x' }), 1800, noSleep)).rejects.toBeInstanceOf(RequestInFlightError);
  });

  it('the replay value type is a flat record of scalars (ids and kinds only; compile-time pin)', async () => {
    const redis = fakeRedis();
    if (false as boolean) {
      // The plan's send replay shape ({ kind, draftId? }) must typecheck.
      await runOnce(redis, 'send', 'pa', P, newRequestKey(), async () => ({ kind: 'draft', draftId: undefined as string | undefined }));
      // @ts-expect-error nested objects (e.g. a summary) are not replay values
      await runOnce(redis, 'send', 'pa', P, newRequestKey(), async () => ({ summary: { text: 'x' } }));
      // @ts-expect-error a bare string is not a replay value
      await runOnce(redis, 'send', 'pa', P, newRequestKey(), async () => 'text');
      // @ts-expect-error arrays are not replay values
      await runOnce(redis, 'send', 'pa', P, newRequestKey(), async () => ({ ids: ['a', 'b'] }));
    }
    expect(true).toBe(true);
  });
});
