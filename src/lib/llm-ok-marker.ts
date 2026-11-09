import { env } from './env';
import { getRedis } from './redis';
import { logWarn } from './log';
import type { RedisLike } from './store';

// llm-ok-marker — the passive proof that the Claude API answers in production
// (weekly reliability report 2026-11-09, item 3). Before this, the only LLM
// signals were failure alerts (llmdown, botfallback); a quiet week looked the
// same as a dead key. chat() (llm.ts) calls the marker after each good reply,
// and the Bearer tier of GET /api/health shows the time as `llmLastOkAt`.
//
// It is best effort and off the reply path: the SET is never awaited, at most
// one write per minute per warm instance, every error is swallowed, and a
// failing Redis logs one warning per instance at most.

export const LLM_LAST_OK_KEY = 'llm:lastOkAt';
/** Long enough to answer "when did it last work?" after a quiet month. */
export const LLM_LAST_OK_TTL_SEC = 30 * 24 * 3600;
export const LLM_OK_WRITE_EVERY_MS = 60_000;

export interface LlmOkMarkerDeps {
  redis: () => Pick<RedisLike, 'set'>;
  now?: () => number;
  warn?: (message: string) => void;
}

export function createLlmOkMarker(deps: LlmOkMarkerDeps): () => void {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((message: string) => logWarn('llm-ok-marker', message));
  let lastWriteMs: number | null = null;
  let warned = false;
  const warnOnce = () => {
    if (warned) return;
    warned = true;
    try {
      warn('could not record llm:lastOkAt');
    } catch {
      // a broken logger must not reach the reply path either
    }
  };

  return function markLlmOk(): void {
    const atMs = now();
    if (lastWriteMs !== null && atMs - lastWriteMs < LLM_OK_WRITE_EVERY_MS) return;
    // Claimed before the write, so overlapping replies do not all write.
    lastWriteMs = atMs;
    // Promise.resolve().then also catches a client that throws synchronously
    // (a missing KV env), so nothing escapes as an unhandled rejection.
    void Promise.resolve()
      .then(() => deps.redis().set(LLM_LAST_OK_KEY, new Date(atMs).toISOString(), { ex: LLM_LAST_OK_TTL_SEC }))
      .catch(warnOnce);
  };
}

/** Production wiring: the shared Upstash client; skipped when KV is not configured (tests, local). */
export const markLlmOk: () => void = createLlmOkMarker({
  redis: () => {
    if (!env.kvUrl || !env.kvToken) return { set: async () => null };
    return getRedis();
  },
});
