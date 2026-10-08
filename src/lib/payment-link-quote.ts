import { getRedis } from './redis';
import { getFxRates } from './rate';
import { assertLegsUsable } from './fx';
import type { RedisLike } from './store';

// payment-link-quote — Batch B2. The rate a payment-link customer SEES is the
// rate they PAY (the B2B quote-lock recipe, b2b-quote-store.ts): the page locks
// the platform USD→INR rate for 15 minutes per link, and the pay route reads
// that lock and never re-quotes. No lock (expired, never shown) ⇒ the route
// answers quote_expired and the page reloads with a fresh rate before the
// customer authorizes anything. A lock holds a PRICE, never funds; Redis only.
//
// v1 prices every link at the platform rate (no partner margin, no best-rate
// routing): the payee's rupee amount is fixed, and the USD side is shown first.

const LOCK_TTL_S = 900;
const LOCK_TTL_MS = LOCK_TTL_S * 1000;

export interface LockedLinkRate {
  /** 1 USD → INR. */
  toInr: number;
  /** The upstream fetch time of the rate (epoch ms); the mint refuses it past FX_MAX_AGE_MS. */
  fetchedAt?: number;
  asOf?: string;
  provider?: string;
  lockedAt: string;
}

const key = (linkId: string) => `paylink_quote:${linkId}`;

export function createLinkQuoteStore(redis: RedisLike, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  return {
    async lock(linkId: string, rate: Omit<LockedLinkRate, 'lockedAt'>): Promise<LockedLinkRate> {
      const locked: LockedLinkRate = { ...rate, lockedAt: new Date(now()).toISOString() };
      await redis.set(key(linkId), JSON.stringify(locked), { ex: LOCK_TTL_S });
      return locked;
    },
    /** The live lock, or null (none, expired, corrupt). Never throws on a bad value. */
    async get(linkId: string): Promise<LockedLinkRate | null> {
      const raw = await redis.get(key(linkId));
      if (!raw) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await redis.del(key(linkId));
        return null;
      }
      const p = parsed as Partial<LockedLinkRate> | null;
      const age = p && typeof p.lockedAt === 'string' ? now() - Date.parse(p.lockedAt) : NaN;
      if (!p || typeof p.toInr !== 'number' || !Number.isFinite(p.toInr) || p.toInr <= 0 || !Number.isFinite(age) || age >= LOCK_TTL_MS) {
        await redis.del(key(linkId));
        return null;
      }
      return p as LockedLinkRate;
    },
  };
}

export type LinkQuoteStore = ReturnType<typeof createLinkQuoteStore>;

let cached: LinkQuoteStore | null = null;
export function getLinkQuoteStore(): LinkQuoteStore {
  if (!cached) cached = createLinkQuoteStore(getRedis());
  return cached;
}

/**
 * The page's rate: the live lock, else a fresh platform USD rate (both FX gates:
 * no fallback table, nothing past the age ceiling) locked for 15 minutes.
 * Throws RateUnavailableError when no usable rate exists (the page says so).
 */
export async function lockedOrFreshLinkRate(store: LinkQuoteStore, linkId: string): Promise<LockedLinkRate> {
  const existing = await store.get(linkId);
  if (existing) return existing;
  const rates = await getFxRates('USD');
  assertLegsUsable(rates);
  return store.lock(linkId, { toInr: rates.toInr, fetchedAt: rates.fetchedAt, asOf: rates.asOf, provider: rates.provider });
}
