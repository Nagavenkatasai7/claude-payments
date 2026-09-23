import { checkIpRateLimit } from './ip-rate-limit';
import type { RedisLike } from './store';
import type { PartnerId } from './types';

// inbound-throttle — Program-Fix 34A. Every inbound WhatsApp message becomes
// one agent.turn (one model run). Without a per-sender budget one number can
// queue unlimited model turns. Limits are per (tenant, phone), owner-accepted:
// 20 a minute and 300 a day (the audit's values).
//
// Fixed windows via checkIpRateLimit (INCR + EXPIRE; the key delimiter is '|',
// so the ':' in `${tenant}:${phone}` is safe). Over a limit the message is NOT
// enqueued, and ONE short "slow down" note goes out per window (claimed with
// SET NX on a per-window key, so a flood never becomes a flood of notes).
// FAILS OPEN: any limiter error allows the message — the bot must keep
// answering when Redis blips. It never throws.

export const WA_TURNS_PER_MINUTE = 20;
export const WA_TURNS_PER_DAY = 300;

/** Sent at most once per window to a sender over the limit. No time promise. */
export const SLOW_DOWN_REPLY =
  "You're sending messages faster than I can answer, so I've paused for a moment. Please wait a little, then send your message again.";

export type InboundThrottleDecision =
  | { allowed: true }
  | { allowed: false; window: 'min' | 'day'; notify: boolean };

const WINDOWS = [
  { name: 'min', scope: 'wa-turns-min', limit: WA_TURNS_PER_MINUTE, windowSec: 60 },
  { name: 'day', scope: 'wa-turns-day', limit: WA_TURNS_PER_DAY, windowSec: 86_400 },
] as const;

export async function checkInboundThrottle(
  redis: RedisLike,
  tenantId: PartnerId,
  phone: string,
  now: number = Date.now(),
): Promise<InboundThrottleDecision> {
  const subject = `${tenantId}:${phone}`;
  for (const w of WINDOWS) {
    let allowed = true;
    try {
      ({ allowed } = await checkIpRateLimit(redis, w.scope, subject, { limit: w.limit, windowSec: w.windowSec, now }));
    } catch {
      return { allowed: true }; // fail open
    }
    if (allowed) continue;
    // One note per window: the key carries the window's bucket, and lives
    // slightly longer than the window it covers.
    const bucket = Math.floor(now / (w.windowSec * 1000));
    let notify = false;
    try {
      notify =
        (await redis.set(`waslow:${subject}:${w.name}:${bucket}`, '1', { nx: true, ex: w.windowSec * 2 })) !== null;
    } catch {
      notify = false; // still refused: a Redis blip on the note must not re-open the flood
    }
    return { allowed: false, window: w.name, notify };
  }
  return { allowed: true };
}
