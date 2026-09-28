import { createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from './store';
import type { PartnerId } from './types';
import { normalizePhone, isValidPhone } from './phone';
import { logWarn } from './log';

/**
 * portal-request-key — the replay guard for NON-MONEY customer portal mutations
 * (UI redesign M2-2, Task 2.5). Money keeps its own claim-first idempotency
 * (pay-finalize); this only stops a double submit or a back-button re-POST from
 * running a portal effect twice (a second recipient write, a second verify email,
 * a second ticket).
 *
 * The form carries a server-minted `requestKey` in a hidden field. `runOnce`
 * claims `preq:<scope>:<sha256(partnerId|phone|requestKey)>` with SET NX EX; only
 * the claim winner runs `fn`, then stores its result under the same key so a
 * replay returns the same value. The key is bound to the customer: the same
 * request key from another partner or phone is a different request.
 *
 * Review round 1, L2:
 * - when `fn` throws, the claim is DELETED before rethrowing, so an honest retry
 *   is not stuck on "still working" for the TTL;
 * - the stored value is a flat record of scalars (the type enforces it), and
 *   callers put only ids and kinds in it, never PII or summary text.
 */

/** What a replay may hand back: ids and kinds only (a flat record of scalars). */
export type ReplayValue = Readonly<Record<string, string | number | boolean | null>>;

export class BadRequestKeyError extends Error {
  constructor() {
    super('Bad request key');
    this.name = 'BadRequestKeyError';
  }
}

/** Another submit with this key is still running; the action shows "Still working, refresh in a moment". */
export class RequestInFlightError extends Error {
  constructor() {
    super('Request in flight');
    this.name = 'RequestInFlightError';
  }
}

const REQUEST_KEY_RE = /^[0-9a-f]{32}$/;
const SCOPE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const PARTNER_MAX = 128;
const POLLS = 3;
const POLL_INTERVAL_MS = 200;

const PENDING = JSON.stringify({ s: 'p' });

/** A 128-bit hex key, minted server-side when a form renders. */
export function newRequestKey(): string {
  return randomBytes(16).toString('hex');
}

function requestRedisKey(scope: string, partnerId: PartnerId, phone: string, requestKey: string): string {
  const digest = createHash('sha256').update(`${partnerId}|${phone}|${requestKey}`).digest('hex');
  return `preq:${scope}:${digest}`;
}

/** The stored result, or null while pending / unreadable. */
function readDone<T>(raw: string | null): { value: T } | null {
  if (typeof raw !== 'string') return null;
  try {
    const env = JSON.parse(raw) as { s?: unknown; v?: unknown };
    return env && env.s === 'd' ? { value: env.v as T } : null;
  } catch {
    return null;
  }
}

export interface RunOnceOptions {
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn` at most once per (scope, partner, phone, requestKey) within `ttlS`.
 * Returns `{ replayed: false, value }` for the run that executed `fn`, and
 * `{ replayed: true, value }` (the stored value) for a replay. A replay that
 * arrives while the first run is still going polls 3 × 200 ms, then throws
 * `RequestInFlightError`. A malformed request key throws `BadRequestKeyError`.
 */
export async function runOnce<T extends ReplayValue | void>(
  redis: RedisLike,
  scope: string,
  partnerId: PartnerId,
  phoneRaw: string,
  requestKey: string,
  fn: () => Promise<T>,
  ttlS = 1800,
  opts: RunOnceOptions = {},
): Promise<{ replayed: boolean; value: T }> {
  if (typeof requestKey !== 'string' || !REQUEST_KEY_RE.test(requestKey)) throw new BadRequestKeyError();
  if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) throw new Error('runOnce: invalid scope');
  if (typeof partnerId !== 'string' || partnerId.length === 0 || partnerId.length > PARTNER_MAX) {
    throw new Error('runOnce: invalid partner');
  }
  const phone = normalizePhone(phoneRaw);
  if (!isValidPhone(phone)) throw new Error('runOnce: invalid phone');
  if (!Number.isInteger(ttlS) || ttlS < 1) throw new Error('runOnce: invalid ttl');

  const key = requestRedisKey(scope, partnerId, phone, requestKey);
  const claimed = await redis.set(key, PENDING, { nx: true, ex: ttlS });

  if (claimed === null) {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < POLLS; i++) {
      const done = readDone<T>(await redis.get(key));
      if (done) return { replayed: true, value: done.value };
      await sleep(POLL_INTERVAL_MS);
    }
    const done = readDone<T>(await redis.get(key));
    if (done) return { replayed: true, value: done.value };
    throw new RequestInFlightError();
  }

  let value: T;
  try {
    value = await fn();
  } catch (err) {
    try {
      await redis.del(key);
    } catch (delErr) {
      logWarn('portal.request_key.release', delErr, { scope });
    }
    throw err;
  }
  try {
    await redis.set(key, JSON.stringify({ s: 'd', v: value }), { ex: ttlS });
  } catch (err) {
    // The effect happened. Keep the pending claim (a retry must not run it again);
    // a replay sees "still working" until the TTL, never a second effect.
    logWarn('portal.request_key.store', err, { scope });
  }
  return { replayed: false, value };
}
