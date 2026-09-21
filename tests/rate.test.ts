import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getFxRate, getFxRates, getDestinationRates, resetRateCacheForTests, setFxL2ForTests,
  FALLBACK_FX_RATE, FALLBACK_FX_RATES, FX_MAX_AGE_MS, AED_PER_USD,
  FRANKFURTER_BASE_URL, FX_UNAVAILABLE_MESSAGE, RateUnavailableError,
} from '@/lib/rate';
import type { CurrencyCode } from '@/lib/types';

// Task 9 (fail-closed FX). Fake timers only where a test ages the cache; every
// advance is RELATIVE (never a hard-coded date — CLAUDE.md fixture rule).

beforeEach(() => {
  resetRateCacheForTests();
  setFxL2ForTests(undefined);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  setFxL2ForTests(undefined);
  vi.restoreAllMocks();
});

function mockFetch(rateINR: number, date = '2026-09-21') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ date, rates: { INR: rateINR } }) }),
  );
}

function mockFetchFailure() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
}

function mockFetchNonOk(status = 503) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }));
}

/** A Map-backed stand-in for the shared Redis L2 (the real one is VITEST-skipped). */
function fakeL2() {
  const m = new Map<string, string>();
  return {
    store: m,
    async get(key: string) { return m.get(key) ?? null; },
    async set(key: string, value: string) { m.set(key, value); return 'OK'; },
  };
}

describe('getFxRates — upstream contract (live-03)', () => {
  it('calls api.frankfurter.dev/v1 directly, never the 301-redirecting .app host', async () => {
    mockFetch(95.82);
    await getFxRates('USD');
    const url = String(vi.mocked(global.fetch).mock.calls[0][0]);
    expect(FRANKFURTER_BASE_URL).toBe('https://api.frankfurter.dev/v1');
    expect(url).toBe('https://api.frankfurter.dev/v1/latest?from=USD&to=INR');
  });

  it('passes an AbortSignal (the per-request timeout) to fetch', async () => {
    mockFetch(95.82);
    await getFxRates('USD');
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('stamps fetchedAt, source: live and the provider fixing date on a successful fetch', async () => {
    mockFetch(95.82, '2026-09-21');
    const before = Date.now();
    const r = await getFxRates('USD');
    expect(r).toMatchObject({ toInr: 95.82, toUsd: 1, source: 'live', asOf: '2026-09-21' });
    expect(r.fetchedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('getFxRates — never a silent constant (money-07 / obs-08)', () => {
  it('throws RateUnavailableError on a fetch failure with nothing cached', async () => {
    mockFetchFailure();
    await expect(getFxRate()).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('carries the customer-safe message, the reason and the currency', async () => {
    mockFetchNonOk(502);
    await expect(getFxRates('USD')).rejects.toMatchObject({
      name: 'RateUnavailableError', reason: 'http_502', currency: 'USD', message: FX_UNAVAILABLE_MESSAGE,
    });
  });

  it('refuses a 200 carrying INR: 0 (prs-04: a zero rate is never cached or served)', async () => {
    mockFetch(0);
    await expect(getFxRates('USD')).rejects.toMatchObject({ reason: 'malformed_rates' });
  });

  it('refuses a non-USD 200 whose USD leg is missing (no static toUsd substitution)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 128.35 } }) }));
    await expect(getFxRates('GBP')).rejects.toMatchObject({ reason: 'malformed_rates', currency: 'GBP' });
  });

  it('refuses a non-USD 200 whose USD leg is 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 128.35, USD: 0 } }) }));
    await expect(getFxRates('GBP')).rejects.toMatchObject({ reason: 'malformed_rates' });
  });
});

describe('getFxRates — the cache ceiling', () => {
  it('within the ceiling, a failed re-fetch serves the last good rate marked source: cache', async () => {
    vi.useFakeTimers();
    mockFetch(88);
    expect(await getFxRate()).toBe(88); // live
    vi.advanceTimersByTime(300_001); // past the 5-min soft TTL ⇒ a re-fetch is attempted
    mockFetchFailure();
    const stale = await getFxRates('USD');
    expect(stale).toMatchObject({ toInr: 88, source: 'cache' });
    expect(Date.now() - (stale.fetchedAt as number)).toBe(300_001);
  });

  it('beyond the ceiling, a failed re-fetch THROWS instead of serving an unbounded cache', async () => {
    vi.useFakeTimers();
    mockFetch(88);
    await getFxRate();
    vi.advanceTimersByTime(FX_MAX_AGE_MS + 1);
    mockFetchFailure();
    await expect(getFxRates('USD')).rejects.toMatchObject({ name: 'RateUnavailableError', currency: 'USD' });
  });

  it('backs off for 30s after a failure (no re-dial on every quote), then retries', async () => {
    vi.useFakeTimers();
    mockFetchFailure();
    await expect(getFxRates('USD')).rejects.toBeInstanceOf(RateUnavailableError);
    await expect(getFxRates('USD')).rejects.toBeInstanceOf(RateUnavailableError);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    mockFetch(95.82);
    expect((await getFxRates('USD')).toInr).toBe(95.82);
  });

  it('a COLD instance serves the fleet L2 copy inside the ceiling when the provider is down', async () => {
    vi.useFakeTimers();
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    mockFetch(95.82);
    await getFxRates('USD'); // warm: writes L1 + L2
    expect(l2.store.has('fx:USD')).toBe(true);
    resetRateCacheForTests(); // a different (cold) instance: empty L1
    vi.advanceTimersByTime(600_000); // L2 copy is 10 min old — past the soft TTL
    mockFetchFailure();
    expect(await getFxRates('USD')).toMatchObject({ toInr: 95.82, source: 'cache' });
  });

  it('a fresh L2 copy is served as live without dialing the provider', async () => {
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    l2.store.set('fx:USD', JSON.stringify({ toInr: 95.5, toUsd: 1, fetchedAt: Date.now(), source: 'live' }));
    mockFetchFailure();
    expect(await getFxRates('USD')).toMatchObject({ toInr: 95.5, source: 'live' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('ignores a pre-deploy L2 row with no fetchedAt (its age is unknowable)', async () => {
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    l2.store.set('fx:USD', JSON.stringify({ toInr: 85, toUsd: 1 }));
    mockFetchFailure();
    await expect(getFxRates('USD')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getFxRates(INR) — any-to-any source (Frankfurter omits the base currency)', () => {
  it('uses identity toInr=1 and the LIVE toUsd when the INR base is omitted from rates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 0.01044 } }) }));
    const r = await getFxRates('INR');
    expect(r).toMatchObject({ toInr: 1, toUsd: 0.01044, source: 'live' });
  });

  it('refuses (no static INR rate) when the fetch fails and nothing is cached', async () => {
    mockFetchFailure();
    await expect(getFxRates('INR')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getFxRates(AED) — derived from the USD peg (obs-08: Frankfurter 404s on AED)', () => {
  it('never fetches AED; derives both legs from the live USD leg', async () => {
    mockFetch(95.82);
    const r = await getFxRates('AED');
    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('from=AED'))).toBe(false);
    expect(r.toUsd).toBeCloseTo(1 / AED_PER_USD, 10);
    expect(r.toInr).toBeCloseTo(95.82 / AED_PER_USD, 10);
    expect(r.source).toBe('live');
  });

  it('inherits the USD leg provenance — a derived rate is never fresher than its base', async () => {
    vi.useFakeTimers();
    mockFetch(95.82);
    await getFxRates('USD');
    vi.advanceTimersByTime(300_001);
    mockFetchFailure();
    expect((await getFxRates('AED')).source).toBe('cache');
  });

  it('refuses AED when the USD leg is unavailable', async () => {
    mockFetchFailure();
    await expect(getFxRates('AED')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getDestinationRates — the quote destination leg', () => {
  it('returns undefined for INR WITHOUT dialing (quote() prices INR off the source leg)', async () => {
    mockFetchFailure();
    expect(await getDestinationRates('INR')).toBeUndefined();
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('returns the destination rates otherwise, and throws like getFxRates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { USD: 1.3395, INR: 128.35 } }) }));
    expect(await getDestinationRates('GBP')).toMatchObject({ toUsd: 1.3395, source: 'live' });
    resetRateCacheForTests();
    mockFetchFailure();
    await expect(getDestinationRates('GBP')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('getFxRate (USD→INR wrapper)', () => {
  it('returns the parsed INR rate on a successful fetch', async () => {
    mockFetch(87.5);
    expect(await getFxRate()).toBe(87.5);
  });

  it('caches the rate — a second call does not fetch again', async () => {
    mockFetch(87.5);
    await getFxRate();
    await getFxRate();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('FALLBACK_FX_RATES — display-only, structurally unquotable', () => {
  it('every entry is tagged source: fallback; FALLBACK_FX_RATE mirrors the USD entry (measured 2026-09-21)', () => {
    for (const r of Object.values(FALLBACK_FX_RATES)) expect(r.source).toBe('fallback');
    expect(FALLBACK_FX_RATE).toBe(FALLBACK_FX_RATES.USD.toInr);
    expect(FALLBACK_FX_RATE).toBe(95.82); // was 85 (−11%)
  });
});

describe('getFxRates — only the typed currency table is ever dialed (Task 9 security review)', () => {
  it('refuses a code outside CurrencyCode without dialing the provider', async () => {
    mockFetch(95.82);
    await expect(getFxRates('EUR' as CurrencyCode)).rejects.toMatchObject({
      name: 'RateUnavailableError', reason: 'unsupported_currency', message: FX_UNAVAILABLE_MESSAGE,
    });
    await expect(getFxRates('USD&to=EUR' as CurrencyCode)).rejects.toBeInstanceOf(RateUnavailableError);
    await expect(getDestinationRates('aed' as CurrencyCode)).rejects.toBeInstanceOf(RateUnavailableError);
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });
});

describe('getFxRates — asOf is a validated ISO date (it is printed on the public landing page)', () => {
  it('drops a provider date that is not YYYY-MM-DD; the rate itself is still live', async () => {
    mockFetch(95.82, 'Rates <b>guaranteed</b> forever');
    const r = await getFxRates('USD');
    expect(r).toMatchObject({ toInr: 95.82, source: 'live' });
    expect(r.asOf).toBeUndefined();
  });

  it('drops a non-ISO asOf read back from the fleet L2 too', async () => {
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    l2.store.set('fx:USD', JSON.stringify({ toInr: 95.5, toUsd: 1, fetchedAt: Date.now(), source: 'live', asOf: 'x'.repeat(500) }));
    mockFetchFailure();
    const r = await getFxRates('USD');
    expect(r).toMatchObject({ toInr: 95.5, source: 'live' });
    expect(r.asOf).toBeUndefined();
  });
});

describe('getFxRates — a future-dated L2 row is not "fresh" (Task 9 review)', () => {
  it('ignores an L2 row whose fetchedAt is more than 2 min ahead of now (it would otherwise pass every age check)', async () => {
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    l2.store.set('fx:USD', JSON.stringify({ toInr: 95.5, toUsd: 1, fetchedAt: Date.now() + 180_000, source: 'live' }));
    mockFetchFailure();
    await expect(getFxRates('USD')).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('tolerates ordinary clock skew between instances (≤ 2 min ahead is still served)', async () => {
    const l2 = fakeL2();
    setFxL2ForTests(l2);
    l2.store.set('fx:USD', JSON.stringify({ toInr: 95.5, toUsd: 1, fetchedAt: Date.now() + 60_000, source: 'live' }));
    mockFetchFailure();
    expect(await getFxRates('USD')).toMatchObject({ toInr: 95.5, source: 'live' });
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });
});
