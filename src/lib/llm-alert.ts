// llm-alert — LLM provider outages reach ops. A provider that rejects the
// account (HTTP 401/402/403, see llm-provider-error.ts) makes EVERY bot turn
// answer with the fallback line; the generic hourly `botfallback` alert does
// not say why. This raises ONE deduped `ops.alert` per status per clock hour
// through the existing outbox (the worker delivers it; see the `ops.alert`
// case in outbox-worker.ts, which sends `payload.message` only).
//
// Contract (cloned from limiter-alert.ts):
//  - llmDownAlertFor is the single source of message + key, so the WhatsApp
//    worker path and the web chat path in the same hour dedupe to ONE row.
//  - The payload is `{ message }` only, built from the status. Never the
//    provider's response body, a phone or a tenant.
//  - Dedupe key `llmdown:<status>:<hourBucket>`: outbox dedupe keys are
//    permanent, so the hour bucket is what lets a lasting outage alert again.
//  - raiseLlmDownAlert (web path) keeps an in-process memo (one entry per
//    status), never throws and is bounded by a deadline. A failed enqueue,
//    even one that fails after the deadline, clears its entry.
//  - The database is imported lazily, like limiter-alert.ts.

import { isPermanentProviderError } from './llm-provider-error';

type Enqueue = (
  kind: 'ops.alert',
  payload: { message: string },
  opts: { dedupeKey: string },
) => Promise<boolean>;

export interface LlmAlertDeps {
  enqueue?: Enqueue;
  now?: () => number;
  /** Deadline for the enqueue (tests). Default LLM_ALERT_TIMEOUT_MS. */
  timeoutMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;
export const LLM_ALERT_TIMEOUT_MS = 1000;

const HINTS: Record<number, string> = {
  401: 'the provider rejected our API key',
  402: 'billing/credits exhausted',
  403: 'access to the model was refused',
};

/** The alert for a fallback caused by `err`, or null unless it is a permanent provider error. Pure. */
export function llmDownAlertFor(err: unknown, hour: number): { message: string; dedupeKey: string } | null {
  if (!isPermanentProviderError(err)) return null;
  const hint = HINTS[err.status] ?? 'request rejected';
  return {
    message:
      `⚠️ SmartRemit ops: the model provider is rejecting every request (HTTP ${err.status}: ${hint}). ` +
      `Every bot turn is answering with the fallback line until this is fixed. Check the Ollama Cloud account.`,
    dedupeKey: `llmdown:${err.status}:${hour}`,
  };
}

// status → the hour bucket already alerted. One entry per status.
const memo = new Map<number, number>();

/** Test-only: forget which status+hour alerts this process already raised. */
export function __resetLlmAlertMemo(): void {
  memo.clear();
}

const defaultEnqueue: Enqueue = async (kind, payload, opts) => {
  const [{ getDb }, { createOutboxRepo }, { pokeWorker }] = await Promise.all([
    import('@/db/client'),
    import('@/db/repos/outbox-repo'),
    import('@/lib/outbox'),
  ]);
  // Inline literal payload: tests/outbox-payload-secrets.test.ts checks every enqueue site.
  const fresh = await createOutboxRepo(getDb()).enqueue(kind, { message: payload.message }, opts);
  pokeWorker();
  return fresh;
};

/** Web path: raise the llmdown alert for `err` (no-op unless permanent). Never throws; bounded. */
export async function raiseLlmDownAlert(err: unknown, deps: LlmAlertDeps = {}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number | undefined;
  let hour: number | undefined;
  // Clear only OUR entry: a later hour may already have replaced it.
  const forget = () => {
    if (status !== undefined && memo.get(status) === hour) memo.delete(status);
  };
  try {
    hour = Math.floor((deps.now ? deps.now() : Date.now()) / HOUR_MS);
    const down = llmDownAlertFor(err, hour);
    if (!down || !isPermanentProviderError(err)) return;
    status = err.status;
    if (memo.get(status) === hour) return;
    memo.set(status, hour);
    const enqueue = deps.enqueue ?? defaultEnqueue;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.timeoutMs ?? LLM_ALERT_TIMEOUT_MS);
    });
    const sent = enqueue('ops.alert', { message: down.message }, { dedupeKey: down.dedupeKey }).catch((e: unknown) => {
      forget();
      throw e;
    });
    await Promise.race([sent, deadline]);
    sent.catch(() => {}); // absorbed if the deadline won
  } catch {
    forget(); // let the next call retry
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
