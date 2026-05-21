export const FALLBACK_FX_RATE = 85;

const CACHE_TTL_MS = 3_600_000; // 1 hour

interface RateCache {
  rate: number;
  fetchedAt: number;
}

let cache: RateCache | null = null;

export function resetRateCacheForTests(): void {
  cache = null;
}

export async function getFxRate(): Promise<number> {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rate;
  }

  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR');
    if (!res.ok) {
      return cache ? cache.rate : FALLBACK_FX_RATE;
    }
    const data = (await res.json()) as { rates: { INR: number } };
    const rate = data.rates.INR;
    cache = { rate, fetchedAt: now };
    return rate;
  } catch {
    return cache ? cache.rate : FALLBACK_FX_RATE;
  }
}
