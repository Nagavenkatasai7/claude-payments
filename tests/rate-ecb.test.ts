import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getFxRates, resetRateCacheForTests, setFxL2ForTests, setEcbSourceForTests, parseEcbDaily,
  ECB_DAILY_URL, ECB_PROVIDER_ID, ECB_HEDGE_MS, FRANKFURTER_BASE_URL, FX_PROVIDER_ID,
  RateUnavailableError,
} from '@/lib/rate';
import type { CurrencyCode } from '@/lib/types';

// Oct 7 2026 incident follow-up: the ECB's own daily file is the FIRST rate
// source and Frankfurter (which republishes the same ECB fixing) the second.
// The rates below are the real ECB file of 2026-10-06 (fetched 2026-10-07).

const ECB_2026_10_06: Record<string, string> = {
  USD: '1.1269', JPY: '178.15', GBP: '0.84880', AUD: '1.6140', CAD: '1.6058', HKD: '8.8438',
  INR: '108.6615', MXN: '20.2217', NZD: '2.0061', SGD: '1.4392',
};

function ecbXml(date = '2026-10-06', rates: Record<string, string> = ECB_2026_10_06): string {
  const cubes = Object.entries(rates)
    .map(([c, r]) => `\t\t\t<Cube currency='${c}' rate='${r}'/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
\t<gesmes:subject>Reference rates</gesmes:subject>
\t<gesmes:Sender>
\t\t<gesmes:name>European Central Bank</gesmes:name>
\t</gesmes:Sender>
\t<Cube>
\t\t<Cube time='${date}'>
${cubes}
\t\t</Cube>
\t</Cube>
</gesmes:Envelope>`;
}

type Responder = (url: string, init?: RequestInit) => Promise<unknown>;

const ok = (body: string) => Promise.resolve({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
const frankfurter = (rates: { USD?: number; INR?: number }, date = '2026-10-06') =>
  ok(JSON.stringify({ amount: 1, base: 'X', date, rates }));
const timeoutError = () => {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
};
/** A fetch that never answers on its own: it rejects only when its signal aborts. */
const hang: Responder = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(timeoutError()));
  });

function route(ecb: Responder, fr: Responder) {
  const fn = vi.fn((url: string, init?: RequestInit) =>
    url.startsWith(ECB_DAILY_URL) ? ecb(url, init) : fr(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const ecbCalls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => String(c[0]) === ECB_DAILY_URL);
const frCalls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => String(c[0]).startsWith(FRANKFURTER_BASE_URL));
const sig6 = (x: number) => Number(x.toPrecision(6));

beforeEach(() => {
  resetRateCacheForTests();
  setFxL2ForTests(undefined);
  setEcbSourceForTests(true);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  setFxL2ForTests(undefined);
  setEcbSourceForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseEcbDaily', () => {
  it('reads the fixing date and every currency per EUR', () => {
    const f = parseEcbDaily(ecbXml());
    expect(f).not.toBe('malformed_rates');
    if (f === 'malformed_rates') return;
    expect(f.asOf).toBe('2026-10-06');
    expect(f.perEur.get('USD')).toBe(1.1269);
    expect(f.perEur.get('INR')).toBe(108.6615);
    expect(f.perEur.get('GBP')).toBe(0.8488);
    expect(f.perEur.size).toBe(Object.keys(ECB_2026_10_06).length);
  });

  it('accepts double-quoted attributes too', () => {
    const f = parseEcbDaily(ecbXml().replace(/'/g, '"'));
    expect(f !== 'malformed_rates' && f.perEur.get('USD')).toBe(1.1269);
  });

  it('drops a rate that is not a positive number and a date that is not YYYY-MM-DD', () => {
    const f = parseEcbDaily(ecbXml('6 Oct 2026', { ...ECB_2026_10_06, GBP: '0', CAD: 'abc', HKD: '0x1A', MXN: '1e2', SGD: '' }));
    if (f === 'malformed_rates') throw new Error('expected a parsed file');
    expect(f.asOf).toBeUndefined();
    for (const c of ['GBP', 'CAD', 'HKD', 'MXN', 'SGD']) expect(f.perEur.has(c)).toBe(false);
  });

  it('is malformed when the USD or INR leg is missing (every cross rate needs both)', () => {
    const { USD: _u, ...noUsd } = ECB_2026_10_06;
    const { INR: _i, ...noInr } = ECB_2026_10_06;
    expect(parseEcbDaily(ecbXml('2026-10-06', noUsd))).toBe('malformed_rates');
    expect(parseEcbDaily(ecbXml('2026-10-06', noInr))).toBe('malformed_rates');
    expect(parseEcbDaily('<html>Service Unavailable</html>')).toBe('malformed_rates');
  });
});

describe('getFxRates — the ECB file is the first source', () => {
  it('prices GBP from the ECB file through EUR, with the ECB date and provider; Frankfurter is not called', async () => {
    const fn = route(() => ok(ecbXml()), () => frankfurter({ USD: 9, INR: 9 }));
    const r = await getFxRates('GBP');
    expect(r).toMatchObject({
      toUsd: sig6(1.1269 / 0.8488), // 1.32764 (Frankfurter served 1.3276)
      toInr: sig6(108.6615 / 0.8488), // 128.018 (Frankfurter served 128.02)
      source: 'live',
      asOf: '2026-10-06',
      provider: ECB_PROVIDER_ID,
    });
    expect(ecbCalls(fn)).toHaveLength(1);
    expect(frCalls(fn)).toHaveLength(0);
  });

  it('USD and INR keep their identity legs', async () => {
    route(() => ok(ecbXml()), () => frankfurter({}));
    expect(await getFxRates('USD')).toMatchObject({ toUsd: 1, toInr: sig6(108.6615 / 1.1269) });
    expect(await getFxRates('INR')).toMatchObject({ toInr: 1, toUsd: sig6(1.1269 / 108.6615) });
  });

  it('AED stays derived from the USD leg (the ECB file has no AED either)', async () => {
    route(() => ok(ecbXml()), () => frankfurter({}));
    const r = await getFxRates('AED');
    expect(r.provider).toBe(ECB_PROVIDER_ID);
    expect(r.toUsd).toBeCloseTo(1 / 3.6725, 10);
  });

  it('ONE ECB call serves every currency asked for at the same time (the health probe asks for 8)', async () => {
    const fn = route(() => ok(ecbXml()), () => frankfurter({}));
    const currencies: CurrencyCode[] = ['GBP', 'CAD', 'SGD', 'AUD', 'NZD', 'INR', 'HKD', 'MXN'];
    const all = await Promise.all(currencies.map((c) => getFxRates(c)));
    expect(all.every((r) => r.provider === ECB_PROVIDER_ID)).toBe(true);
    expect(ecbCalls(fn)).toHaveLength(1);
  });

  it('stores the provider in the fleet L2 and reads it back on a cold instance', async () => {
    const m = new Map<string, string>();
    setFxL2ForTests({ get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return 'OK'; } });
    route(() => ok(ecbXml()), () => frankfurter({}));
    await getFxRates('GBP');
    expect(JSON.parse(m.get('fx:GBP')!)).toMatchObject({ provider: ECB_PROVIDER_ID });
    resetRateCacheForTests(); // cold instance: L1 empty, L2 kept
    const fn = route(() => ok(ecbXml()), () => frankfurter({}));
    expect((await getFxRates('GBP')).provider).toBe(ECB_PROVIDER_ID);
    expect(fn).not.toHaveBeenCalled();
  });

  it('drops an unknown provider read back from L2 (never free text into a transfer row)', async () => {
    const m = new Map<string, string>([[
      'fx:GBP', JSON.stringify({ toInr: 128, toUsd: 1.33, fetchedAt: Date.now(), provider: '<script>' }),
    ]]);
    setFxL2ForTests({ get: async (k) => m.get(k) ?? null, set: async () => 'OK' });
    route(() => ok(ecbXml()), () => frankfurter({}));
    const r = await getFxRates('GBP');
    expect(r.toInr).toBe(128);
    expect(r.provider).toBeUndefined();
  });
});

describe('getFxRates — Frankfurter is the second source', () => {
  it('an ECB error answer falls through to Frankfurter at once, and logs fx.ecb-fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = route(() => Promise.resolve({ ok: false, status: 503, text: async () => '' }), () => frankfurter({ USD: 1.3276, INR: 128.02 }));
    const r = await getFxRates('GBP');
    expect(r).toMatchObject({ toUsd: 1.3276, toInr: 128.02, source: 'live', provider: FX_PROVIDER_ID });
    expect(ecbCalls(fn)).toHaveLength(1);
    expect(frCalls(fn)).toHaveLength(1);
    const lines = warn.mock.calls.filter((c) => String(c[0]).includes('fx.ecb-fallback'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0][0]))).toMatchObject({ currency: 'GBP', reason: 'http_503' });
  });

  it('a malformed ECB file falls through to Frankfurter', async () => {
    route(() => ok('<html>maintenance</html>'), () => frankfurter({ USD: 1.3276, INR: 128.02 }));
    expect((await getFxRates('GBP')).provider).toBe(FX_PROVIDER_ID);
  });

  it('a currency missing from the ECB file falls through to Frankfurter', async () => {
    const { MXN: _m, ...noMxn } = ECB_2026_10_06;
    route(() => ok(ecbXml('2026-10-06', noMxn)), () => frankfurter({ USD: 0.05573, INR: 5.3734 }));
    expect(await getFxRates('MXN')).toMatchObject({ toUsd: 0.05573, provider: FX_PROVIDER_ID });
  });

  it(`a SLOW ECB file: Frankfurter is asked after ${ECB_HEDGE_MS} ms and its answer is served`, async () => {
    vi.useFakeTimers();
    const fn = route(hang, () => frankfurter({ USD: 1.3276, INR: 128.02 }));
    const p = getFxRates('GBP');
    await vi.advanceTimersByTimeAsync(ECB_HEDGE_MS - 1);
    expect(frCalls(fn)).toHaveLength(0); // not yet: the ECB file still has time
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ toUsd: 1.3276, provider: FX_PROVIDER_ID });
    expect(frCalls(fn)).toHaveLength(1);
  });

  it('when BOTH sources fail, the refusal is unchanged (RateUnavailableError, nothing cached)', async () => {
    route(() => Promise.reject(new Error('net')), () => Promise.reject(timeoutError()));
    await expect(getFxRates('GBP')).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('when BOTH fail with a rate cached, the last good rate is served as cache', async () => {
    vi.useFakeTimers();
    route(() => ok(ecbXml()), () => frankfurter({}));
    await getFxRates('GBP');
    vi.advanceTimersByTime(301_000); // past the soft TTL
    route(() => Promise.reject(new Error('net')), () => Promise.reject(timeoutError()));
    expect(await getFxRates('GBP')).toMatchObject({ source: 'cache', provider: ECB_PROVIDER_ID });
  });

  it('a failed ECB call is not reused: the next refresh dials the ECB file again', async () => {
    vi.useFakeTimers();
    const fn = route(() => Promise.reject(new Error('net')), () => frankfurter({ USD: 1.3276, INR: 128.02 }));
    await getFxRates('GBP');
    vi.advanceTimersByTime(301_000);
    await getFxRates('GBP');
    expect(ecbCalls(fn)).toHaveLength(2);
  });

  it('with the ECB source off (the vitest default), only Frankfurter is dialed', async () => {
    setEcbSourceForTests(undefined);
    const fn = route(() => ok(ecbXml()), () => frankfurter({ USD: 1.3276, INR: 128.02 }));
    expect((await getFxRates('GBP')).provider).toBe(FX_PROVIDER_ID);
    expect(ecbCalls(fn)).toHaveLength(0);
  });
});
