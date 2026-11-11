import { describe, it, expect, vi, afterEach } from 'vitest';
import { Redis } from '@upstash/redis';
import { createConsumeRedis } from '@/lib/redis';

// Fix pack 4 review R1-P4 (B2): a GETDEL is not idempotent, so the one-shot
// consume of a payment code runs on a client that sends each command ONCE.
// @upstash/redis 1.39.0 `retry: false` still makes TWO fetch attempts
// (node_modules/@upstash/redis/chunk-4WQYU7T6.mjs:125-131 sets attempts: 1, and
// the loop at :167 runs `i <= attempts`); `retries: 0` makes exactly one.

const netError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createConsumeRedis (R1-P4 B2)', () => {
  it('sends a failed GETDEL exactly once and rethrows the network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(netError());
    vi.stubGlobal('fetch', fetchMock);
    const client = createConsumeRedis('https://consume.example.invalid', 'test-token');
    await expect(client.getdel('k')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads values raw (automaticDeserialization: false): a JSON string comes back as the same string', async () => {
    const stored = JSON.stringify({ a: 1 });
    // The client auto-pipelines, so the REST answer is the pipeline array.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ result: stored }]), { status: 200 })));
    const client = createConsumeRedis('https://consume.example.invalid', 'test-token');
    expect(await client.getdel('k')).toBe(stored);
  });

  it('library pin: `retry: false` alone would still retry once (why the consume client uses retries: 0)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(netError());
    vi.stubGlobal('fetch', fetchMock);
    const client = new Redis({ url: 'https://consume.example.invalid', token: 'test-token', retry: false });
    await expect(client.getdel('k')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
