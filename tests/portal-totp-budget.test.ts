/**
 * M2-14 (#394 L2): a per-(partner, phone) daily budget of FAILED authenticator
 * codes across portal sign-in and step-up. The per-token cap (5) restarts with
 * every new token; this one does not. Reserved atomically before the compare,
 * refunded on success, fail closed on a Redis error.
 */
import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createPortalTotpBudget, PORTAL_TOTP_FAILS_PER_DAY } from '@/lib/portal-totp-budget';

const P = '14155550101';

describe('portal TOTP failure budget', () => {
  it('allows PORTAL_TOTP_FAILS_PER_DAY failed attempts, then refuses (no compare)', async () => {
    const b = createPortalTotpBudget(fakeRedis(), { now: () => Date.UTC(2026, 8, 29, 12) });
    for (let i = 0; i < PORTAL_TOTP_FAILS_PER_DAY; i++) expect(await b.reserve('pa', P)).toBe(true);
    expect(await b.reserve('pa', P)).toBe(false);
  });

  it('a success refunds its reservation (a customer who signs in often is never locked)', async () => {
    const b = createPortalTotpBudget(fakeRedis(), { now: () => Date.UTC(2026, 8, 29, 12) });
    for (let i = 0; i < PORTAL_TOTP_FAILS_PER_DAY * 3; i++) {
      expect(await b.reserve('pa', P)).toBe(true);
      await b.refund('pa', P);
    }
    expect(await b.reserve('pa', P)).toBe(true);
  });

  it('a refund that lands in a NEW day never leaves a negative, TTL-less key', async () => {
    let t = Date.UTC(2026, 8, 29, 23, 59, 59);
    const r = fakeRedis();
    const b = createPortalTotpBudget(r, { now: () => t });
    await b.reserve('pa', P);
    t = Date.UTC(2026, 8, 30, 0, 0, 1);
    await b.refund('pa', P);
    for (const [k, v] of r.dump) if (k.startsWith('ptotp:')) expect(Number(v)).toBeGreaterThanOrEqual(0);
  });

  it('is per partner and per phone (digits-normalised), and resets on the next UTC day', async () => {
    let t = Date.UTC(2026, 8, 29, 23);
    const b = createPortalTotpBudget(fakeRedis(), { now: () => t });
    for (let i = 0; i < PORTAL_TOTP_FAILS_PER_DAY; i++) await b.reserve('pa', P);
    expect(await b.reserve('pa', `+${P}`)).toBe(false);
    expect(await b.reserve('pb', P)).toBe(true);
    expect(await b.reserve('pa', '14155550102')).toBe(true);
    t = Date.UTC(2026, 8, 30, 0, 1);
    expect(await b.reserve('pa', P)).toBe(true);
  });

  it('a Redis error propagates (callers fail closed); the key never holds the raw phone', async () => {
    const r = fakeRedis();
    const keys: string[] = [];
    const spy = { ...r, incr: async (k: string) => { keys.push(k); return r.incr(k); } };
    await createPortalTotpBudget(spy as never).reserve('pa', P);
    expect(keys[0]).not.toContain(P);
    const broken = { ...r, incr: async () => { throw new Error('down'); } };
    await expect(createPortalTotpBudget(broken as never).reserve('pa', P)).rejects.toThrow();
  });
});
