import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFxRates, resetRateCacheForTests, FALLBACK_FX_RATES } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.restoreAllMocks();
});

function mockFetch(body: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

describe('getFxRates', () => {
  it('USD source short-circuits toUsd=1 and fetches only INR', async () => {
    mockFetch({ rates: { INR: 85 } });
    const r = await getFxRates('USD');
    expect(r).toEqual({ toInr: 85, toUsd: 1 });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=USD');
    expect(url).toContain('to=INR');
    expect(url).not.toContain('USD,INR');
  });

  it('non-USD source returns both toInr and toUsd', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    const r = await getFxRates('GBP');
    expect(r).toEqual({ toInr: 108, toUsd: 1.27 });
    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('from=GBP');
    expect(url).toContain('to=USD,INR');
  });

  it('caches per source currency independently', async () => {
    mockFetch({ rates: { USD: 1.27, INR: 108 } });
    await getFxRates('GBP');
    await getFxRates('GBP');
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1); // GBP cached
  });

  it('falls back to the per-currency table on fetch failure with no cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const r = await getFxRates('AED');
    expect(r).toEqual(FALLBACK_FX_RATES.AED);
  });
});
