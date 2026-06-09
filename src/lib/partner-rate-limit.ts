import type { RedisLike } from './store';

// partner-rate-limit — a per-partner fixed-window limiter for the Partner API.
// Keyed by partnerId + minute so one partner exhausting their budget can NEVER
// throttle another (cross-tenant isolation). INCR + EXPIRE on the window key.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

const DEFAULT_LIMIT_PER_MIN = 120;

export async function checkPartnerRateLimit(
  redis: RedisLike,
  partnerId: string,
  opts: { limit?: number; now?: number } = {},
): Promise<RateLimitResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT_PER_MIN;
  const minute = Math.floor((opts.now ?? Date.now()) / 60_000);
  const key = `ratelimit:${partnerId}:${minute}`;
  const count = await redis.incr(key);
  // Set a TTL once when the window opens so old counters self-evict.
  if (count === 1) await redis.expire(key, 120);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
}
