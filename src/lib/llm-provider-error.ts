// llm-provider-error — a leaf (no imports) so the worker, the agent and
// llm-alert can classify a provider failure without loading ollama.ts (tests
// that mock '@/lib/ollama' must not break the worker's fallback alert).
//
// 401/402/403 mean the provider rejected the account (key, billing, model
// access): a retry can never succeed, so the agent skips it and ops is told at
// once. 429 and 5xx stay transient.

export const PERMANENT_PROVIDER_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);

export class OllamaHttpError extends Error {
  readonly permanent: boolean;
  constructor(
    readonly status: number,
    body: string,
  ) {
    // Same prefix as before, body capped so a large error page is never logged whole.
    super(`Ollama request failed (${status}): ${body.slice(0, 500)}`);
    this.name = 'OllamaHttpError';
    this.permanent = PERMANENT_PROVIDER_STATUSES.has(status);
  }
}

export function isPermanentProviderError(err: unknown): err is OllamaHttpError {
  return err instanceof OllamaHttpError && err.permanent;
}
