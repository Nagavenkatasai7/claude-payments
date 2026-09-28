// site-tenant-resolver — slug → ACTIVE partner id for partner subdomains. FAILS CLOSED.
//
// Loaded LAZILY by src/proxy.ts (only on a subdomain host) and by getSiteTenant(); apex never
// imports it, so the apex proxy path stays free of Redis/DB.
//
// Order: slug rules (reserved / ??-- / format) → Redis cache → per-IP limiter (misses only) → DB.
// Only a real DB answer is cached: a partner id, or '-' for "no active partner". A throttled miss,
// a Redis error or a DB error is NEVER cached, so one blip cannot blank a live site for the TTL.
// Unknown, disabled, throttled and errored all return null, which the proxy renders as ONE
// generic sheet (no oracle). Logs carry the slug only, never the IP.
import { getRedis } from '@/lib/redis';
import type { RedisLike } from '@/lib/store';
import { getDb, type DbOrTx } from '@/db/client';
import { findActivePartnerIdBySlug } from '@/db/repos/partner-site-repo';
import { isIpRateLimited } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';
import { isValidSiteSlug, siteCacheKey, SITE_CACHE_TTL_SEC } from '@/lib/site-host';

export { siteCacheKey, SITE_CACHE_TTL_SEC };

/** Cache misses allowed per IP per minute before the IP sees the generic sheet. */
export const SITE_HOST_IP_LIMIT = 120;
const REDIS_TIMEOUT_MS = 800;
const NEGATIVE = '-';

export interface ResolveSiteDeps {
  redis?: RedisLike;
  db?: DbOrTx;
  limited?: (h: Headers) => Promise<boolean>;
  redisTimeoutMs?: number;
}

const TIMED_OUT = Symbol('timeout');
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveSiteSlug(slug: string, reqHeaders: Headers, deps: ResolveSiteDeps = {}): Promise<string | null> {
  // Platform/reserved/invalid labels are refused before any lookup.
  if (!isValidSiteSlug(slug)) return null;
  const key = siteCacheKey(slug);

  let redis: RedisLike | null = null;
  try {
    redis = deps.redis ?? getRedis();
    const cached = await withDeadline(redis.get(key), deps.redisTimeoutMs ?? REDIS_TIMEOUT_MS);
    if (cached === NEGATIVE) return null;
    if (typeof cached === 'string' && cached) return cached;
  } catch {
    logWarn('site-tenant', 'slug cache read failed', { slug });
  }

  const limited = deps.limited ?? ((h: Headers) => isIpRateLimited(h, 'sitehost', SITE_HOST_IP_LIMIT, 60));
  try {
    if (await limited(reqHeaders)) return null;
  } catch {
    // The limiter fails open; the DB lookup below still decides.
  }

  let partnerId: string | null;
  try {
    partnerId = await findActivePartnerIdBySlug(deps.db ?? getDb(), slug);
  } catch {
    logWarn('site-tenant', 'slug lookup failed', { slug });
    return null;
  }

  if (redis) {
    try {
      await withDeadline(redis.set(key, partnerId ?? NEGATIVE, { ex: SITE_CACHE_TTL_SEC }), deps.redisTimeoutMs ?? REDIS_TIMEOUT_MS);
    } catch {
      logWarn('site-tenant', 'slug cache write failed', { slug });
    }
  }
  return partnerId;
}
