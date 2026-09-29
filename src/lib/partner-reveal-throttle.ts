import type { RedisLike } from './store';

// partner-reveal-throttle (UI redesign M3-11): a fixed-window budget for audited PII reveals in the
// partner app, per (tenant, staff member). It bounds how fast one session (or a stolen one) can
// walk a tenant's customer list. The key carries ids only: never a phone or a customer ref. It
// THROWS on a Redis error, and the caller treats a throw as a refusal (fails closed): this guards a
// disclosure path, unlike the fail-open per-IP limiter on public routes.

export const REVEAL_LIMIT = 30;
/** A tenant-wide ceiling per window: creating more staff accounts does not multiply the budget. */
export const REVEAL_TENANT_LIMIT = 200;
export const REVEAL_WINDOW_S = 15 * 60;

export function revealThrottleKey(partnerId: string, username: string, nowMs: number): string {
  const window = Math.floor(nowMs / (REVEAL_WINDOW_S * 1000));
  return `pii:reveal:${partnerId}:${window}:${username}`;
}

async function hit(redis: RedisLike, key: string, limit: number): Promise<boolean> {
  const n = await redis.incr(key);
  // The TTL is set when the window opens, so old counters evict themselves.
  if (n === 1) await redis.expire(key, REVEAL_WINDOW_S * 2);
  return n <= limit;
}

/**
 * Spend one reveal from the staff member's budget AND the tenant's ceiling. true = allowed. A
 * staff member over their own budget is refused before the tenant counter is touched, so one
 * account cannot drain its colleagues' share. Throws when Redis fails.
 */
export async function takeRevealBudget(
  redis: RedisLike,
  partnerId: string,
  username: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!(await hit(redis, revealThrottleKey(partnerId, username, nowMs), REVEAL_LIMIT))) return false;
  const window = Math.floor(nowMs / (REVEAL_WINDOW_S * 1000));
  return hit(redis, `pii:reveal:tenant:${partnerId}:${window}`, REVEAL_TENANT_LIMIT);
}
