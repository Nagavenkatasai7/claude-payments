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
  INR: { toInr: 1, toUsd: 0.0118 }, // never a source currency; present for type completeness
};

const CACHE_TTL_MS = 3_600_000; // 1 hour

interface CacheEntry {
  rates: FxRates;
  fetchedAt: number;
}

const cache = new Map<CurrencyCode, CacheEntry>();

export function resetRateCacheForTests(): void {
  cache.clear();
}

export async function getFxRates(source: CurrencyCode): Promise<FxRates> {
  const now = Date.now();
  const cached = cache.get(source);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.rates;

  try {
    const to = source === 'USD' ? 'INR' : 'USD,INR';
    const res = await fetch(`https://api.frankfurter.app/latest?from=${source}&to=${to}`);
    if (!res.ok) return cached ? cached.rates : FALLBACK_FX_RATES[source];
    const data = (await res.json()) as { rates: { USD?: number; INR: number } };
    const rates: FxRates = {
      toInr: data.rates.INR,
      toUsd: source === 'USD' ? 1 : data.rates.USD ?? FALLBACK_FX_RATES[source].toUsd,
    };
    cache.set(source, { rates, fetchedAt: now });
    return rates;
  } catch {
    return cached ? cached.rates : FALLBACK_FX_RATES[source];
  }
}

// Thin back-compat wrapper: callers that only need USD→INR.
export async function getFxRate(): Promise<number> {
  return (await getFxRates('USD')).toInr;
}
