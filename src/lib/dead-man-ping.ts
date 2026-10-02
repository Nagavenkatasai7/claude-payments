import { logWarn } from '@/lib/log';

// dead-man-ping — the PUSH half of the external dead-man's switch. After each
// COMPLETED cron-sourced full worker run, /api/worker sends one GET to
// WORKER_HEARTBEAT_URL (a Healthchecks.io-style check). If the Vercel cron or
// the drain dies, the pings stop and the outside service raises the alarm.
// Poke and GitHub-workflow runs never ping, so they cannot mask a dead cron.
//
// Fail-open: it never throws, and it is bounded by the caller's remaining
// budget. The URL is never logged — anyone holding it can fake liveness. URL
// policy (https only, default port, no userinfo, no internal host) is
// enforced by the injected safeFetch (src/lib/settlement-url.ts).

/** Upper bound on one ping. */
export const DEAD_MAN_PING_TIMEOUT_MS = 3_000;
/** Below this much budget the ping is skipped rather than risk the platform kill. */
export const DEAD_MAN_PING_MIN_BUDGET_MS = 500;

export type DeadManPingResult = 'unset' | 'skipped' | 'sent' | 'failed';

/** safeFetch's fixed codes are safe to log; anything else is reduced to its error name. */
function errorLabel(err: unknown): string {
  if (err instanceof Error && /^settlement_(url_refused|fetch_failed):[A-Za-z0-9_]{1,64}$/.test(err.message)) {
    return err.message;
  }
  return err instanceof Error ? err.name : 'unknown';
}

export async function pingDeadMan(opts: {
  rawUrl: string;
  fetchFn: typeof fetch;
  /** Milliseconds left before the invocation's hard stop. */
  budgetMs: number;
}): Promise<DeadManPingResult> {
  const url = opts.rawUrl.trim();
  if (!url) return 'unset';
  if (!(opts.budgetMs >= DEAD_MAN_PING_MIN_BUDGET_MS)) return 'skipped';
  try {
    const res = await opts.fetchFn(url, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.min(DEAD_MAN_PING_TIMEOUT_MS, opts.budgetMs)),
    });
    if (res.ok) return 'sent';
    logWarn('worker.dead-man-ping', 'dead-man ping failed', { status: res.status });
    return 'failed';
  } catch (err) {
    logWarn('worker.dead-man-ping', 'dead-man ping failed', { error: errorLabel(err) });
    return 'failed';
  }
}
