// limiter-alert — Program-Fix 45 (P2). A limiter that cannot reach Redis used
// to degrade silently: the per-IP guards fail OPEN (availability wins on money
// endpoints) and the pay-page confirmation-code issue fails CLOSED. Either way
// ops heard nothing. This raises ONE deduped `ops.alert` per scope per clock
// hour through the existing outbox (the worker delivers it; see the
// `ops.alert` case in outbox-worker.ts, which sends `payload.message` only).
//
// Contract:
//  - The payload is `{ message }` only, built from the scope name and mode.
//    Never the error text: an Upstash error can echo the command, and the
//    per-IP key embeds the client IP. Never a phone or a transfer id.
//  - Dedupe key `limiter-down:<scope>:<hourBucket>`: outbox dedupe keys are
//    permanent, so the hour bucket is what lets a lasting outage alert again.
//  - An in-process memo per scope+hour stops an outage turning every request
//    into a database insert. A failed enqueue clears its memo entry so the next
//    call retries.
//  - Never throws, and is bounded by a deadline (a stalled database must not
//    stall the request that noticed the Redis failure).
//  - The database is imported lazily: ip-rate-limit.ts has ~20 importers and
//    none of them should load the Neon pool just by importing the limiter.

export type LimiterMode = 'fail-open' | 'fail-closed';

type Enqueue = (
  kind: 'ops.alert',
  payload: { message: string },
  opts: { dedupeKey: string },
) => Promise<boolean>;

export interface LimiterAlertDeps {
  enqueue?: Enqueue;
  now?: () => number;
  /** Deadline for the enqueue (tests). Default LIMITER_ALERT_TIMEOUT_MS. */
  timeoutMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;
export const LIMITER_ALERT_TIMEOUT_MS = 1000;

const memo = new Set<string>();

/** Test-only: forget which scope+hour alerts this process already raised. */
export function __resetLimiterAlertMemo(): void {
  memo.clear();
}

const defaultEnqueue: Enqueue = async (kind, payload, opts) => {
  const [{ getDb }, { createOutboxRepo }] = await Promise.all([
    import('@/db/client'),
    import('@/db/repos/outbox-repo'),
  ]);
  // Inline literal payload: tests/outbox-payload-secrets.test.ts checks every enqueue site.
  return createOutboxRepo(getDb()).enqueue(kind, { message: payload.message }, opts);
};

function messageFor(scope: string, mode: LimiterMode): string {
  const effect =
    mode === 'fail-open'
      ? 'requests are being allowed through without the per-IP limit'
      : 'confirmation codes are NOT being sent until Redis recovers';
  return (
    `⚠️ SmartRemit ops: the "${scope}" limiter could not reach Redis (${mode}): ${effect}. ` +
    `Check Upstash health.`
  );
}

export async function raiseLimiterDownAlert(
  scope: string,
  mode: LimiterMode,
  deps: LimiterAlertDeps = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let memoKey: string | undefined;
  try {
    const safeScope = scope.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const hour = Math.floor((deps.now ? deps.now() : Date.now()) / HOUR_MS);
    memoKey = `${safeScope}:${hour}`;
    if (memo.has(memoKey)) return;
    memo.add(memoKey);
    const enqueue = deps.enqueue ?? defaultEnqueue;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.timeoutMs ?? LIMITER_ALERT_TIMEOUT_MS);
    });
    // Promise.race subscribes to both, so a late rejection is absorbed.
    await Promise.race([
      enqueue(
        'ops.alert',
        { message: messageFor(safeScope, mode) },
        { dedupeKey: `limiter-down:${memoKey}` },
      ),
      deadline,
    ]);
  } catch {
    if (memoKey) memo.delete(memoKey); // let the next call retry
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
