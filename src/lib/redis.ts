import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';

// redis — THE shared Upstash client (Stage 4). Previously 13 modules each
// constructed their own `new Redis(...)`; one HTTP client with one config is
// cheaper (connection/agent reuse under Fluid Compute) and makes the
// `automaticDeserialization: false` contract impossible to half-apply (the
// hgetall flat-array gotcha came from exactly that drift).
//
// The ONE deliberate exception: ip-rate-limit.ts keeps a private no-retry
// client — a slow limiter must never add retry latency to a money path.

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
