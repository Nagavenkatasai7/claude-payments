import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';

// redis — THE shared Upstash client (Stage 4). Previously 13 modules each
// constructed their own `new Redis(...)`; one HTTP client with one config is
// cheaper (connection/agent reuse under Fluid Compute) and makes the
// `automaticDeserialization: false` contract impossible to half-apply (the
// hgetall flat-array gotcha came from exactly that drift).
//
// Two deliberate exceptions: ip-rate-limit.ts keeps a private no-retry
// client — a slow limiter must never add retry latency to a money path — and
// getConsumeRedis() below serves the one-shot consumes that must never be resent.

let cached: RedisLike | null = null;

export function getRedis(): RedisLike {
  if (!cached) {
    cached = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    }) as unknown as RedisLike;
  }
  return cached;
}

/**
 * Fix pack 4 review R1-P4 (B2): Upstash options for a command that must reach
 * the server AT MOST ONCE (a GETDEL consume). The shared client retries a
 * failed fetch up to 5 times; if the first GETDEL ran but its response was
 * lost, the retry answers null and a correct code reads as "wrong". `retries: 0`
 * sends each command once; `retry: false` would NOT (@upstash/redis 1.39.0
 * chunk-4WQYU7T6.mjs:125-131 maps it to attempts: 1, and the loop at :167 runs
 * `i <= attempts`, i.e. two fetches). A network error then propagates.
 */
const CONSUME_RETRY = { retries: 0, backoff: () => 0 };

/** A client that sends each command once (never retried); same raw-string contract as getRedis(). */
export function createConsumeRedis(url: string, token: string): RedisLike {
  return new Redis({ url, token, automaticDeserialization: false, retry: CONSUME_RETRY }) as unknown as RedisLike;
}

let consumeCached: RedisLike | null = null;

/** The shared no-retry client, for single-use consumes ONLY (transaction-otp's code GETDEL). */
export function getConsumeRedis(): RedisLike {
  if (!consumeCached) consumeCached = createConsumeRedis(env.kvUrl, env.kvToken);
  return consumeCached;
}
