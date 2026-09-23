import { describe, it, expect, vi, beforeEach } from 'vitest';
import { raiseLimiterDownAlert, __resetLimiterAlertMemo } from '@/lib/limiter-alert';

// Program-Fix 45 (P2): a limiter that cannot reach Redis raises ONE deduped
// ops.alert per scope per clock hour. The payload is {message} only, with no
// phone, id, IP or error text. It never throws.
const HOUR_MS = 60 * 60 * 1000;
const T0 = 1_750_000_000_000;

beforeEach(() => __resetLimiterAlertMemo());

describe('raiseLimiterDownAlert', () => {
  it('enqueues one ops.alert with a {message}-only payload and an hourly dedupe key', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    await raiseLimiterDownAlert('pay', 'fail-open', { enqueue, now: () => T0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [kind, payload, opts] = enqueue.mock.calls[0];
    expect(kind).toBe('ops.alert');
    expect(Object.keys(payload)).toEqual(['message']);
    expect(payload.message).toMatch(/pay/);
    expect(payload.message).toMatch(/fail-open/);
    expect(opts).toEqual({ dedupeKey: `limiter-down:pay:${Math.floor(T0 / HOUR_MS)}` });
  });

  it('memoises per scope per hour in-process: an outage does not insert on every request', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    for (let i = 0; i < 5; i++) await raiseLimiterDownAlert('pay', 'fail-open', { enqueue, now: () => T0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    await raiseLimiterDownAlert('rail', 'fail-open', { enqueue, now: () => T0 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    await raiseLimiterDownAlert('pay', 'fail-open', { enqueue, now: () => T0 + HOUR_MS });
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls[2][2].dedupeKey).toBe(`limiter-down:pay:${Math.floor(T0 / HOUR_MS) + 1}`);
  });

  it('never throws when the enqueue fails, and retries on the next call', async () => {
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(true);
    await expect(raiseLimiterDownAlert('pay', 'fail-open', { enqueue, now: () => T0 })).resolves.toBeUndefined();
    await raiseLimiterDownAlert('pay', 'fail-open', { enqueue, now: () => T0 });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('is bounded: a hanging enqueue resolves at the deadline', async () => {
    const enqueue = vi.fn(() => new Promise<boolean>(() => {}));
    const t = Date.now();
    await raiseLimiterDownAlert('txotp-issue', 'fail-closed', { enqueue, now: () => T0, timeoutMs: 20 });
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('a fail-closed alert says codes are not being sent', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    await raiseLimiterDownAlert('txotp-issue', 'fail-closed', { enqueue, now: () => T0 });
    expect(enqueue.mock.calls[0][1].message).toMatch(/fail-closed/);
    expect(enqueue.mock.calls[0][1].message).toMatch(/code/i);
  });

  it('keeps the scope in the key safe: odd characters are replaced', async () => {
    const enqueue = vi.fn().mockResolvedValue(true);
    await raiseLimiterDownAlert('a b|c', 'fail-open', { enqueue, now: () => T0 });
    expect(enqueue.mock.calls[0][2].dedupeKey).toBe(`limiter-down:a_b_c:${Math.floor(T0 / HOUR_MS)}`);
  });
});
