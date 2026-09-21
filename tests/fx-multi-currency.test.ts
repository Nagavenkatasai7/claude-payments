import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFxRates, resetRateCacheForTests, FX_MAX_AGE_MS, RateUnavailableError } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

function mockFetch(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

describe('getFxRates', () => {
  it('USD source short-circuits toUsd=1 and fetches only INR', async () => {
    mockFetch({ rates: { INR: 85 } });
    const r = await getFxRates('USD');
    expect(r).toMatchObject({ toInr: 85, toUsd: 1, source: 'live' });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=USD');
    expect(url).toContain('to=INR');
    expect(url).not.toContain('USD,INR');
  });

  it('non-USD source returns both toInr and toUsd', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    const r = await getFxRates('GBP');
    expect(r).toMatchObject({ toInr: 108, toUsd: 1.27, source: 'live' });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=GBP');
    expect(url).toContain('to=USD,INR');
  });

  it('caches per source currency independently', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    await getFxRates('GBP');
    await getFxRates('GBP');
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1); // GBP cached
    await getFxRates('CAD'); // a distinct currency must trigger its own fetch
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
  });

  it('AED is derived from the USD peg, never fetched (Frankfurter 404s on AED)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('from=AED')
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, json: async () => ({ rates: { INR: 95.82 } }) }));
    const r = await getFxRates('AED');
    expect(r.toUsd).toBeCloseTo(0.27229, 5); // 1 / 3.6725
    expect(r.toInr).toBeCloseTo(26.0912, 3); // 95.82 / 3.6725
    expect(vi.mocked(global.fetch).mock.calls.every(([u]) => !String(u).includes('from=AED'))).toBe(true);
  });

  it('refuses (never caches NaN, never serves a constant) when a 200 response omits INR', async () => {
    mockFetch({ rates: { USD: 1.27 } });
    await expect(getFxRates('GBP')).rejects.toMatchObject({ name: 'RateUnavailableError', reason: 'malformed_rates' });
  });

  it('serves the cache with source: cache when a non-USD re-fetch fails INSIDE the ceiling', async () => {
    vi.useFakeTimers();
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    expect(await getFxRates('GBP')).toMatchObject({ toInr: 108, toUsd: 1.27, source: 'live' });
    vi.advanceTimersByTime(300_001);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await getFxRates('GBP')).toMatchObject({ toInr: 108, toUsd: 1.27, source: 'cache' });
  });

  it('refuses a non-USD re-fetch failure BEYOND the ceiling instead of serving an unbounded cache', async () => {
    vi.useFakeTimers();
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    await getFxRates('GBP');
    vi.advanceTimersByTime(FX_MAX_AGE_MS + 1);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    await expect(getFxRates('GBP')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});
