import { describe, it, expect, vi } from 'vitest';
import { createLlmOkMarker, LLM_LAST_OK_KEY, LLM_LAST_OK_TTL_SEC, LLM_OK_WRITE_EVERY_MS } from '@/lib/llm-ok-marker';

// The production writer behind chat()'s onSuccess: a best-effort Redis SET of
// llm:lastOkAt, at most once a minute per instance, never awaited and never
// rejecting. Times are relative to a fake clock, never hardcoded dates.

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(setImpl?: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>) {
  let nowMs = Date.now();
  const set = vi.fn(setImpl ?? (async () => 'OK'));
  const warn = vi.fn();
  const mark = createLlmOkMarker({ redis: () => ({ set }), now: () => nowMs, warn });
  return { set, warn, mark, advance: (ms: number) => (nowMs += ms), now: () => nowMs };
}

describe('createLlmOkMarker', () => {
  it('writes the ISO time with a 30-day TTL', async () => {
    const h = harness();
    h.mark();
    await flush();
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set).toHaveBeenCalledWith(LLM_LAST_OK_KEY, new Date(h.now()).toISOString(), { ex: LLM_LAST_OK_TTL_SEC });
    expect(LLM_LAST_OK_KEY).toBe('llm:lastOkAt');
    expect(LLM_LAST_OK_TTL_SEC).toBe(30 * 24 * 3600);
  });

  it('two successes inside 60 s give one write; the next after 60 s gives a second', async () => {
    const h = harness();
    h.mark();
    h.advance(LLM_OK_WRITE_EVERY_MS - 1);
    h.mark();
    await flush();
    expect(h.set).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.mark();
    await flush();
    expect(h.set).toHaveBeenCalledTimes(2);
  });

  it('returns before the write settles (fire and forget)', () => {
    const h = harness(() => new Promise(() => {}));
    expect(h.mark()).toBeUndefined();
  });

  it('a rejecting SET or a throwing client never throws, and warns at most once', async () => {
    const h = harness(async () => { throw new Error('upstash down'); });
    expect(() => h.mark()).not.toThrow();
    await flush();
    h.advance(LLM_OK_WRITE_EVERY_MS);
    h.mark();
    await flush();
    expect(h.set).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledTimes(1);

    const warn = vi.fn();
    const mark = createLlmOkMarker({ redis: () => { throw new Error('KV env missing'); }, warn });
    expect(() => mark()).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
