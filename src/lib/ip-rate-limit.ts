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

// ── Program-Fix 23: the hosted pay-page guard ────────────────────────────────
// /pay/<id> and /pay/b2b/<id> are unauthenticated GETs that read the ledger and
// render the recipient, amounts and fee. The POST routes are limited (scope
// 'pay'); the PAGES were not, so one address could enumerate ids against the
// database at wire speed. This guard runs BEFORE any data read.

/** Scope for the hosted pay-page GETs. Separate from the POST 'pay' scope so a burst of reloads never eats the payment budget. */
export const PAY_PAGE_SCOPE = 'paypage';
/** Per-IP page renders per window. Generous on purpose: reloads, double renders, link previews. */
export const PAY_PAGE_IP_LIMIT = 60;

/**
 * Deadline for one page-guard lookup (review S1). `retry: false` bounds
 * ERRORS, not HANGS: a stalled Upstash would otherwise stall every /pay/<id>
 * render, including transfer-backed links that never touched Redis before
 * fix 23. Past this the guard answers "allowed" (fail-open).
 */
export const PAY_PAGE_GUARD_TIMEOUT_MS = 1500;

export interface IpGuardDeps {
  redis?: RedisLike;
  now?: () => number;
  /** Deadline override (tests). Default PAY_PAGE_GUARD_TIMEOUT_MS. */
  timeoutMs?: number;
}

// A page-guard-only client. The shared `limiterRedis()` above serves the 12
// POST callers and is untouched. This one adds a per-request abort so the HTTP
// request itself is released at the deadline: the FUNCTION form of `signal`
// (`signal?: AbortSignal | (() => AbortSignal)`, @upstash/redis 1.38.1
// error-8y4qG0W2.d.ts:132) yields a fresh AbortSignal per request and the
// request throws on abort instead of retrying (same pattern as fix 12's
// worker-cadence.ts). The Promise.race in isIpRateLimited is the contract;
// this abort is what stops a dead socket from outliving the render.
let pageGuardCached: RedisLike | null = null;
function pageGuardRedis(): RedisLike {
  if (!pageGuardCached) {
    pageGuardCached = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
      retry: false,
      signal: () => AbortSignal.timeout(PAY_PAGE_GUARD_TIMEOUT_MS),
    }) as unknown as RedisLike;
  }
  return pageGuardCached;
}

/**
 * Page-facing guard: `true` ⇒ over budget, render the generic sheet; `false` ⇒
 * render normally. It FAILS OPEN and NEVER THROWS: any limiter error, a Redis
 * outage, a limiter that does not answer within PAY_PAGE_GUARD_TIMEOUT_MS, or
 * an unknown client IP (no forwarded header — one shared bucket would lock out
 * everyone behind a header-stripping proxy) all yield `false`. Nothing is
 * logged here: the guard must not leak the id or the decision.
 *
 * `headers` is the Fetch `Headers` shape; Next's `await headers()` returns a
 * `ReadonlyHeaders` (next/dist/server/request/headers.d.ts:11) that satisfies
 * it, exactly as `clientIpFrom(await headers())` does in waitlist-action.ts.
 * `deps` lets tests inject a fake Redis, a fixed clock and a shorter deadline.
 */
export async function isIpRateLimited(
  headers: Headers,
  scope: string,
  limit: number,
  windowSec = 60,
  deps: IpGuardDeps = {},
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ip = clientIpFrom(headers);
    if (ip === 'unknown') return false;
    const timeoutMs = deps.timeoutMs ?? PAY_PAGE_GUARD_TIMEOUT_MS;
    // The deadline resolves "allowed": a stalled limiter must never hide a
    // customer's payment sheet. Promise.race subscribes to both inputs, so a
    // late rejection from the losing limiter call is absorbed, never unhandled.
    const deadline = new Promise<IpRateLimitResult>((resolve) => {
      timer = setTimeout(() => resolve({ allowed: true, remaining: limit, limit }), timeoutMs);
    });
    const result = await Promise.race([
      checkIpRateLimit(deps.redis ?? pageGuardRedis(), scope, ip, {
        limit,
        windowSec,
        now: deps.now ? deps.now() : Date.now(),
      }),
      deadline,
    ]);
    return !result.allowed;
  } catch {
    return false; // fail-open: availability wins on a money page
  } finally {
    if (timer !== undefined) clearTimeout(timer); // never keep the function alive
  }
}
