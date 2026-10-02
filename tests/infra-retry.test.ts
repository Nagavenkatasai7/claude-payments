import { describe, it, expect, vi } from 'vitest';
import { retryOnceOnInfra, INFRA_RETRY_DELAY_MS } from '@/lib/infra-retry';

// Fix D: one bounded retry of an IDEMPOTENT read on an infrastructure error
// only (isInfraError). Real timers throughout: the retry awaits a setTimeout.

const dnsBlip = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo EBUSY x.upstash.io'), { code: 'EBUSY', syscall: 'getaddrinfo' }),
  });

describe('retryOnceOnInfra', () => {
  it('the default delay is 200 ms', () => {
    expect(INFRA_RETRY_DELAY_MS).toBe(200);
  });

  it('success on the first call: read once, value returned', async () => {
    const read = vi.fn().mockResolvedValue('v1');
    await expect(retryOnceOnInfra(read, 0)).resolves.toBe('v1');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('an infra error then success: read exactly twice, returns the second value', async () => {
    const read = vi.fn().mockRejectedValueOnce(dnsBlip()).mockResolvedValueOnce('v2');
    await expect(retryOnceOnInfra(read, 0)).resolves.toBe('v2');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('infra twice: throws the SECOND error and never reads a third time', async () => {
    const second = Object.assign(new Error('Exhausted all retries'), { tag: 2 });
    const read = vi.fn().mockRejectedValueOnce(dnsBlip()).mockRejectedValueOnce(second).mockResolvedValue('never');
    await expect(retryOnceOnInfra(read, 0)).rejects.toBe(second);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a non-infra error is rethrown immediately (WRONGTYPE, a plain bug)', async () => {
    for (const err of [
      Object.assign(new Error('WRONGTYPE Operation against a key holding the wrong kind of value, command was: ["get"]'), { name: 'UpstashError' }),
      new Error('boom'),
    ]) {
      const read = vi.fn().mockRejectedValue(err);
      await expect(retryOnceOnInfra(read, 0)).rejects.toBe(err);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it('waits delayMs before the retry', async () => {
    const calls: number[] = [];
    const read = vi.fn(async () => {
      calls.push(performance.now());
      if (calls.length === 1) throw dnsBlip();
      return 'ok';
    });
    await expect(retryOnceOnInfra(read, 60)).resolves.toBe('ok');
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(55);
  });
});
