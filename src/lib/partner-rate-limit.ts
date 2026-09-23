import type { RedisLike } from './store';

// partner-rate-limit — a per-partner (and, since fix 44, per-key) fixed-window
// limiter for the Partner API.
// Keyed by partnerId + minute so one partner exhausting their budget can NEVER
// throttle another (cross-tenant isolation). INCR + EXPIRE on the window key.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

const DEFAULT_LIMIT_PER_MIN = 120;

async function hitWindow(redis: RedisLike, key: string, limit: number): Promise<RateLimitResult> {
  const count = await redis.incr(key);
  // Set a TTL once when the window opens so old counters self-evict.
  if (count === 1) await redis.expire(key, 120);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
}

export async function checkPartnerRateLimit(
  redis: RedisLike,
  partnerId: string,
  opts: { limit?: number; now?: number; keyId?: string; keyLimit?: number } = {},
): Promise<RateLimitResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT_PER_MIN;
  const minute = Math.floor((opts.now ?? Date.now()) / 60_000);
  const partner = await hitWindow(redis, `ratelimit:${partnerId}:${minute}`, limit);
  if (!opts.keyId) return partner;
  // Program-Fix 44 P1: a per-KEY window too — one leaked or runaway key can't
  // spend its siblings' budget. Both windows must pass.
  const key = await hitWindow(
    redis,
    `ratelimit:key:${opts.keyId}:${minute}`,
    opts.keyLimit ?? DEFAULT_LIMIT_PER_MIN,
  );
  const binding = key.remaining < partner.remaining ? key : partner;
  return {
    allowed: partner.allowed && key.allowed,
    remaining: Math.min(partner.remaining, key.remaining),
    limit: binding.limit,
  };
}
