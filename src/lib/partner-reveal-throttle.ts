import type { RedisLike } from './store';

// partner-reveal-throttle (UI redesign M3-11): a fixed-window budget for audited PII reveals in the
// partner app, per (tenant, staff member). It bounds how fast one session (or a stolen one) can
// walk a tenant's customer list. The key carries ids only: never a phone or a customer ref. It
// THROWS on a Redis error, and the caller treats a throw as a refusal (fails closed): this guards a
// disclosure path, unlike the fail-open per-IP limiter on public routes.

export const REVEAL_LIMIT = 30;
export const REVEAL_WINDOW_S = 15 * 60;

export function revealThrottleKey(partnerId: string, username: string, nowMs: number): string {
  const window = Math.floor(nowMs / (REVEAL_WINDOW_S * 1000));
  return `pii:reveal:${partnerId}:${window}:${username}`;
}

/** Spend one reveal from the budget. true = allowed. Throws when Redis fails. */
export async function takeRevealBudget(
  redis: RedisLike,
  partnerId: string,
  username: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const key = revealThrottleKey(partnerId, username, nowMs);
  const n = await redis.incr(key);
  // The TTL is set when the window opens, so old counters evict themselves.
  if (n === 1) await redis.expire(key, REVEAL_WINDOW_S * 2);
  return n <= REVEAL_LIMIT;
}
