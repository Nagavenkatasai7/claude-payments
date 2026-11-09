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
//
// SKIN slugs (src/lib/site-skins.ts, e.g. `tgfl`: a partner-branded look that an EXISTING tenant
// serves) take one extra step before that order:
//   1. status, cached under its OWN key (skinCacheKey; same TTL, same limiter and deadlines on a
//      miss): 'held' = a partner holds or ever held the slug, 'inactive' = the skin's tenant is not
//      active, 'ok' = free and active. A throttled miss or a DB error is never cached → null.
//   2. 'held' → the NORMAL path below decides (the partner wins; the skin never takes over or blanks
//      a partner's host, whatever the switch says). 'inactive' → null.
//   3. 'ok' → the "TGFL demo portal" switch (flag portal.skins) is read on EVERY call, under the DB
//      deadline. Anything but a clear "on" (off, slow, error) → null. On → the skin's tenant.
// The skin ANSWER is never cached and never written to the slug cache, so turning the switch off
// stops the host within the flag cache's 15 s, and an old slug-cache entry can never shadow it.
import { getRedis } from '@/lib/redis';
import type { RedisLike } from '@/lib/store';
import { getDb, type DbOrTx } from '@/db/client';
import { findActivePartnerIdBySlug, readSkinSlugStatus } from '@/db/repos/partner-site-repo';
import { isFlagOn } from '@/lib/flags';
import { isIpRateLimited } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';
import { isValidSiteSlug, siteCacheKey, SITE_CACHE_TTL_SEC } from '@/lib/site-host';
import { skinForSlug, type SiteSkin } from '@/lib/site-skins';

export { siteCacheKey, SITE_CACHE_TTL_SEC };

/** Redis key of a skin slug's STATUS ('ok' | 'held' | 'inactive'). Never holds a partner id. */
export const skinCacheKey = (slug: string) => `site:v1:skin:${slug}`;
type SkinStatus = 'ok' | 'held' | 'inactive';
const isSkinStatus = (v: unknown): v is SkinStatus => v === 'ok' || v === 'held' || v === 'inactive';

/** Cache misses allowed per IP per minute before the IP sees the generic sheet. */
export const SITE_HOST_IP_LIMIT = 120;
const REDIS_TIMEOUT_MS = 800;
/** A stalled DB must not hold a subdomain request open: past this, fail closed (uncached). */
const DB_TIMEOUT_MS = 2500;
const NEGATIVE = '-';

export interface ResolveSiteDeps {
  redis?: RedisLike;
  db?: DbOrTx;
  limited?: (h: Headers) => Promise<boolean>;
  redisTimeoutMs?: number;
  dbTimeoutMs?: number;
  /** The skin switch (default: flag `portal.skins` on `db`). Asked on every call for a skin slug only. */
  skinsOn?: () => Promise<boolean>;
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

/** The per-IP limiter for cache misses. Fails open: the DB lookup still decides. */
async function isLimited(reqHeaders: Headers, deps: ResolveSiteDeps): Promise<boolean> {
  const limited = deps.limited ?? ((h: Headers) => isIpRateLimited(h, 'sitehost', SITE_HOST_IP_LIMIT, 60));
  try {
    return await limited(reqHeaders);
  } catch {
    return false;
  }
}

/**
 * Step 1 for a skin slug: its status, from the status cache or (on a miss) the DB. null = no answer
 * (throttled, DB error or timeout): the caller fails closed and nothing is cached. `counted` says
 * the limiter already counted this request, so the normal path does not count it twice.
 */
async function readSkinStatus(
  skin: SiteSkin,
  reqHeaders: Headers,
  deps: ResolveSiteDeps,
): Promise<{ status: SkinStatus | null; counted: boolean }> {
  const slug = skin.slug;
  const key = skinCacheKey(slug);
  const redisMs = deps.redisTimeoutMs ?? REDIS_TIMEOUT_MS;
  let redis: RedisLike | null = null;
  try {
    redis = deps.redis ?? getRedis();
    const cached = await withDeadline(redis.get(key), redisMs);
    // Anything but one of the three known words is a miss: the DB decides.
    if (isSkinStatus(cached)) return { status: cached, counted: false };
  } catch {
    logWarn('site-tenant', 'skin cache read failed', { slug });
  }

  if (await isLimited(reqHeaders, deps)) return { status: null, counted: true };

  let status: SkinStatus;
  try {
    const answer = await withDeadline(readSkinSlugStatus(deps.db ?? getDb(), slug, skin.partnerId), deps.dbTimeoutMs ?? DB_TIMEOUT_MS);
    if (answer === TIMED_OUT) {
      logWarn('site-tenant', 'skin status lookup timed out', { slug });
      return { status: null, counted: true };
    }
    status = answer.held ? 'held' : answer.tenantActive ? 'ok' : 'inactive';
  } catch {
    logWarn('site-tenant', 'skin status lookup failed', { slug });
    return { status: null, counted: true };
  }

  if (redis) {
    try {
      await withDeadline(redis.set(key, status, { ex: SITE_CACHE_TTL_SEC }), redisMs);
    } catch {
      logWarn('site-tenant', 'skin cache write failed', { slug });
    }
  }
  return { status, counted: true };
}

/** Step 3 for a skin slug: true only on a clear "on". Off, slow or failing all read as off. */
async function skinSwitchOn(slug: string, deps: ResolveSiteDeps): Promise<boolean> {
  const skinsOn = deps.skinsOn ?? (() => isFlagOn(deps.db ?? getDb(), 'portal.skins'));
  try {
    return (await withDeadline(skinsOn(), deps.dbTimeoutMs ?? DB_TIMEOUT_MS)) === true;
  } catch {
    logWarn('site-tenant', 'skin switch read failed', { slug });
    return false;
  }
}

export async function resolveSiteSlug(slug: string, reqHeaders: Headers, deps: ResolveSiteDeps = {}): Promise<string | null> {
  // Platform/reserved/invalid labels are refused before any lookup.
  if (!isValidSiteSlug(slug)) return null;

  // A skin slug (see the header). Only 'held' continues to the normal path below.
  let limiterCounted = false;
  const skin = skinForSlug(slug);
  if (skin) {
    const { status, counted } = await readSkinStatus(skin, reqHeaders, deps);
    if (status === null || status === 'inactive') return null;
    if (status === 'ok') return (await skinSwitchOn(slug, deps)) ? skin.partnerId : null;
    limiterCounted = counted;
  }

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

  // One count per request: a skin status miss above already counted this one.
  if (!limiterCounted && (await isLimited(reqHeaders, deps))) return null;

  let partnerId: string | null;
  try {
    const answer = await withDeadline(findActivePartnerIdBySlug(deps.db ?? getDb(), slug), deps.dbTimeoutMs ?? DB_TIMEOUT_MS);
    if (answer === TIMED_OUT) {
      logWarn('site-tenant', 'slug lookup timed out', { slug });
      return null;
    }
    partnerId = answer;
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
