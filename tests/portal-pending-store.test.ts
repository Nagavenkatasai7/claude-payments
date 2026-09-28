import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createPortalPendingStore, PORTAL_PENDING_MAX_ATTEMPTS } from '@/lib/portal-pending-store';

// UI redesign M2-5: the single-use, partner-bound token that carries a sign-in (or step-up) between
// its steps. Redis holds sha256(token) only; the phone lives in the record, never in a key, and the
// token is only ever returned to the browser (never the phone).

describe('portal pending store', () => {
  it('create → peek on the SAME partner and purpose; a 256-bit hex token; no token or phone in any key', async () => {
    const redis = fakeRedis();
    const store = createPortalPendingStore(redis);
    const token = await store.create({ partnerId: 'pa', phone: '14155550101', purpose: 'login' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.peek(token, 'pa', 'login')).toMatchObject({ partnerId: 'pa', phone: '14155550101', purpose: 'login' });
    for (const k of redis.dump.keys()) {
      expect(k).not.toContain(token);
      expect(k).not.toContain('14155550101');
    }
  });
  it('another partner (host mismatch), another purpose, a malformed or unknown token → null', async () => {
    const store = createPortalPendingStore(fakeRedis());
    const token = await store.create({ partnerId: 'pa', phone: '14155550101', purpose: 'login' });
    expect(await store.peek(token, 'pb', 'login')).toBeNull();
    expect(await store.peek(token, 'pa', 'mfa')).toBeNull();
    expect(await store.peek('zz', 'pa', 'login')).toBeNull();
    expect(await store.peek('b'.repeat(64), 'pa', 'login')).toBeNull();
  });
  it('expires in code (logical TTL), whatever Redis did', async () => {
    let now = 1_000_000;
    const store = createPortalPendingStore(fakeRedis(), { now: () => now });
    const token = await store.create({ partnerId: 'pa', phone: '14155550101', purpose: 'login' });
    now += 301_000;
    expect(await store.peek(token, 'pa', 'login')).toBeNull();
  });
  it('a step-up token carries the session id and is bound to it', async () => {
    const store = createPortalPendingStore(fakeRedis());
    const token = await store.create({ partnerId: 'pa', phone: '14155550101', purpose: 'stepup', sid: 'c'.repeat(32) });
    expect((await store.peek(token, 'pa', 'stepup'))?.sid).toBe('c'.repeat(32));
  });
  it(`countAttempt counts per token (the ${PORTAL_PENDING_MAX_ATTEMPTS}-per-token cap is the caller's)`, async () => {
    const store = createPortalPendingStore(fakeRedis());
    const a = await store.create({ partnerId: 'pa', phone: '14155550101', purpose: 'login' });
    const b = await store.create({ partnerId: 'pa', phone: '14155550101', purpose: 'login' });
    expect(await store.countAttempt(a)).toBe(1);
    expect(await store.countAttempt(a)).toBe(2);
    expect(await store.countAttempt(b)).toBe(1);
  });
  it('consume is single-use', async () => {
    const store = createPortalPendingStore(fakeRedis());
    const token = await store.create({ partnerId: 'pa', phone: '14155550101', purpose: 'login' });
    await store.consume(token);
    expect(await store.peek(token, 'pa', 'login')).toBeNull();
  });
  it('create refuses an invalid phone or partner', async () => {
    const store = createPortalPendingStore(fakeRedis());
    await expect(store.create({ partnerId: 'pa', phone: '12', purpose: 'login' })).rejects.toThrow();
    await expect(store.create({ partnerId: '', phone: '14155550101', purpose: 'login' })).rejects.toThrow();
  });
});
