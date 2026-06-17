import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFxRate, getFxRates, resetRateCacheForTests, FALLBACK_FX_RATE } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(rateINR: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: rateINR } }),
    }),
  );
}

function mockFetchFailure() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('Network error')),
  );
}

function mockFetchNonOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }),
  );
}

describe('getFxRates(INR) — any-to-any source (Frankfurter omits the base currency)', () => {
  it('uses identity toInr=1 and the LIVE toUsd when the INR base is omitted from rates', async () => {
    // from=INR&to=USD,INR → Frankfurter returns ONLY USD (no INR key for the base).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { USD: 0.0106 } }),
    }));
    const r = await getFxRates('INR');
    expect(r.toInr).toBe(1);        // INR→INR identity (not the static 1, but derived)
    expect(r.toUsd).toBe(0.0106);   // LIVE INR→USD — NOT the static 0.0118 fallback
  });

  it('falls back to the static INR rate only when the fetch fails', async () => {
    mockFetchFailure();
    const r = await getFxRates('INR');
    expect(r.toUsd).toBe(0.0118); // static fallback
  });
});

describe('getFxRate', () => {
  it('returns the parsed INR rate on successful fetch', async () => {
    mockFetch(87.5);
    const rate = await getFxRate();
    expect(rate).toBe(87.5);
  });

  it('caches the rate — second call does not fetch again', async () => {
    mockFetch(87.5);
    await getFxRate();
    await getFxRate();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('returns FALLBACK_FX_RATE on fetch failure with no cache', async () => {
    mockFetchFailure();
    const rate = await getFxRate();
    expect(rate).toBe(FALLBACK_FX_RATE);
  });

  it('returns FALLBACK_FX_RATE on non-ok response with no cache', async () => {
    mockFetchNonOk();
    const rate = await getFxRate();
    expect(rate).toBe(FALLBACK_FX_RATE);
  });

  it('returns the last cached rate when a re-fetch fails after TTL expiry', async () => {
    vi.useFakeTimers();
    try {
      mockFetch(88.0);
      expect(await getFxRate()).toBe(88.0); // populates the cache

      // advance past the 1-hour TTL so the next call attempts a re-fetch
      vi.advanceTimersByTime(3_600_001);
      mockFetchFailure();

      const stale = await getFxRate();
      expect(stale).toBe(88.0); // serves the stale cache, not the fallback
      expect(stale).not.toBe(FALLBACK_FX_RATE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FALLBACK_FX_RATE is 85', () => {
    expect(FALLBACK_FX_RATE).toBe(85);
  });
});
