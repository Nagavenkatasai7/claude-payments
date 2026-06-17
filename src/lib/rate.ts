import type { CurrencyCode } from './types';

export interface FxRates {
  toInr: number; // 1 unit of source currency → INR (shown to the customer)
  toUsd: number; // 1 unit of source currency → USD (for USD-equivalent accounting)
}

// Back-compat: USD→INR fallback. Kept because tests and getFxRate() reference it.
export const FALLBACK_FX_RATE = 85;

// Conservative offline fallbacks; only used when a live fetch fails with no cache.
export const FALLBACK_FX_RATES: Record<CurrencyCode, FxRates> = {
  USD: { toInr: 85, toUsd: 1 },
  GBP: { toInr: 108, toUsd: 1.27 },
  CAD: { toInr: 62, toUsd: 0.73 },
  AED: { toInr: 23.1, toUsd: 0.27 },
  SGD: { toInr: 63, toUsd: 0.74 },
  AUD: { toInr: 56, toUsd: 0.66 },
  NZD: { toInr: 51, toUsd: 0.6 },
  INR: { toInr: 1, toUsd: 0.0118 }, // ≈ 1/85; any-to-any offline fallback for an INR SOURCE (e.g. India → US)
};

// Stage 4: 5-minute freshness (was 1h) — quotes on a money product should
// track the market. L1 = per-instance memory; L2 = shared Redis, so a cold
// instance reuses the fleet's fetch instead of dialing Frankfurter again.
const CACHE_TTL_MS = 300_000;

interface CacheEntry {
  rates: FxRates;
  fetchedAt: number;
}

const cache = new Map<CurrencyCode, CacheEntry>();

export function resetRateCacheForTests(): void {
  cache.clear();
}

// L2 is skipped under vitest: unit tests stub GLOBAL fetch with a Frankfurter
// response, and the Upstash client rides the same fetch — it would parse the
// FX payload as a Redis REST reply. Lazy + fail-open: no Redis, no L2.
async function l2Get(source: CurrencyCode): Promise<FxRates | null> {
  if (process.env.VITEST) return null;
  try {
    const { getRedis } = await import('./redis');
    const raw = await getRedis().get(`fx:${source}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FxRates;
    return Number.isFinite(parsed.toInr) && Number.isFinite(parsed.toUsd) ? parsed : null;
  } catch {
    return null;
  }
}

async function l2Set(source: CurrencyCode, rates: FxRates): Promise<void> {
  if (process.env.VITEST) return;
  try {
    const { getRedis } = await import('./redis');
    await getRedis().set(`fx:${source}`, JSON.stringify(rates), { ex: 300 });
  } catch {
    /* best effort */
  }
}

export async function getFxRates(source: CurrencyCode): Promise<FxRates> {
  const now = Date.now();
  const cached = cache.get(source);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.rates;

  // Shared L2 before the upstream call — one Frankfurter fetch per 5 min
  // across the whole fleet, not per instance.
  const shared = await l2Get(source);
  if (shared) {
    cache.set(source, { rates: shared, fetchedAt: now });
    return shared;
  }

  try {
    const to = source === 'USD' ? 'INR' : 'USD,INR';
    const res = await fetch(`https://api.frankfurter.app/latest?from=${source}&to=${to}`);
    if (!res.ok) return cached ? cached.rates : FALLBACK_FX_RATES[source];
    const data = (await res.json()) as { rates: { USD?: number; INR?: number } };
    // Frankfurter OMITS the base currency from `rates`, so an INR base never
    // echoes an INR key — its source→INR rate is the identity 1 (any-to-any: INR
    // is now a valid source). Without this, every INR-source quote silently fell
    // back to the static rate instead of live FX.
    const inr = source === 'INR' ? 1 : data.rates.INR;
    if (typeof inr !== 'number' || !Number.isFinite(inr)) {
      // Malformed 200 (missing INR) — treat as a failure; never cache NaN.
      return cached ? cached.rates : FALLBACK_FX_RATES[source];
    }
    let toUsd: number;
    if (source === 'USD') {
      toUsd = 1;
    } else if (typeof data.rates.USD === 'number' && Number.isFinite(data.rates.USD)) {
      toUsd = data.rates.USD;
    } else {
      console.warn(`getFxRates(${source}): USD rate missing in response; using fallback toUsd`);
      toUsd = FALLBACK_FX_RATES[source].toUsd;
    }
    const rates: FxRates = { toInr: inr, toUsd };
    cache.set(source, { rates, fetchedAt: now });
    await l2Set(source, rates);
    return rates;
  } catch {
    return cached ? cached.rates : FALLBACK_FX_RATES[source];
  }
}

// Thin back-compat wrapper: callers that only need USD→INR.
export async function getFxRate(): Promise<number> {
  return (await getFxRates('USD')).toInr;
}
