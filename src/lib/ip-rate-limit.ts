import { Redis } from '@upstash/redis';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from './env';
import type { RedisLike } from './store';

// ip-rate-limit — per-IP fixed-window limiter for the PUBLIC endpoints
// (Stage 3). Complements the per-entity throttles (per-partner API budget,
// per-phone OTP caps, per-IP login lockout): this is the blunt outer ring that
// stops one address from hammering a money endpoint at all.
//
// Fixed window (INCR + EXPIRE), keyed `iprl|{scope}|{ip}|{window}` — scopes
// never share budgets, and the route-facing guard FAILS OPEN on Redis errors:
// a rate-limiter outage must never block payments (the inner per-entity
// throttles still hold).

export interface IpRateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export async function checkIpRateLimit(
  redis: RedisLike,
  scope: string,
  ip: string,
  opts: { limit: number; windowSec?: number; now?: number },
): Promise<IpRateLimitResult> {
  const windowSec = Math.max(1, opts.windowSec ?? 60);
  const window = Math.floor((opts.now ?? Date.now()) / (windowSec * 1000));
  // Delimit with '|', not ':' — ':' is valid in both scope names and IPv6
  // addresses, so a ':'-joined key could collide (scope='a:b',ip='c' would key
  // the same cell as scope='a',ip='b:c'). '|' appears in neither, so keys stay unique.
  const key = `iprl|${scope}|${ip}|${window}`;
  const count = await redis.incr(key);
  // TTL set once when the window opens; stale counters self-evict.
  if (count === 1) await redis.expire(key, windowSec * 2);
  return {
    allowed: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
    limit: opts.limit,
  };
}

/**
 * The client IP for limiting. On Vercel the platform sets x-forwarded-for and
 * the FIRST entry is the connecting client (not spoofable through the edge).
 */
export function clientIpFrom(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for') ?? '';
  return fwd.split(',')[0].trim() || headers.get('x-real-ip') || 'unknown';
}

let cached: RedisLike | null = null;
function limiterRedis(): RedisLike {
  if (!cached) {
    cached = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
      retry: false, // a slow limiter must never slow a money path
    }) as unknown as RedisLike;
  }
  return cached;
}

/**
 * Route-facing guard. Returns the 429 response to send, or null to proceed.
 * Fail-OPEN on any limiter error — availability wins on money endpoints.
 */
export async function enforceIpRateLimit(
  req: NextRequest,
  scope: string,
  limit: number,
  windowSec = 60,
): Promise<NextResponse | null> {
  try {
    const now = Date.now();
    const result = await checkIpRateLimit(limiterRedis(), scope, clientIpFrom(req.headers), {
      limit,
      windowSec,
      now,
    });
    if (!result.allowed) {
      // Accurate Retry-After: seconds until THIS fixed window rolls over, not a
      // full window (which over-states the wait for a request late in a window).
      const windowMs = windowSec * 1000;
      const windowEnd = (Math.floor(now / windowMs) + 1) * windowMs;
      const retryAfterSec = Math.ceil((windowEnd - now) / 1000);
      return NextResponse.json(
        { ok: false, error: 'Too many requests — please retry in a minute.' },
        { status: 429, headers: { 'retry-after': String(retryAfterSec) } },
      );
    }
    return null;
  } catch {
    return null; // fail-open
  }
}
