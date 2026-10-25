// llm-provider-error — a leaf (no imports) so the worker, the agent and
// llm-alert can classify a provider failure without loading llm.ts (tests
// that mock '@/lib/llm' must not break the worker's fallback alert).
//
// 401/402/403 mean the provider rejected the account (key, billing, model
// access): a retry can never succeed, so the agent skips it and ops is told at
// once. A 429 is transient, except the monthly spend cap: the Claude API
// answers it with error_code `enforced_spend_limit_reached` and no
// retry-after, and every call fails until the 1st of the next month
// (https://platform.claude.com/docs/en/api/rate-limits#reaching-your-spend-cap).
// 5xx and 529 (overloaded) stay transient.

export const PERMANENT_PROVIDER_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);

export const SPEND_CAP_ERROR_CODE = 'enforced_spend_limit_reached';

export class ProviderHttpError extends Error {
  readonly permanent: boolean;
  /** The spend cap (or our own Console spend limit) stopped the call. */
  readonly spendCap: boolean;
  constructor(
    readonly status: number,
    detail: string,
    opts: { spendCap?: boolean } = {},
  ) {
    // Detail capped so a large error page is never logged whole.
    super(`Model request failed (${status}): ${detail.slice(0, 500)}`);
    this.name = 'ProviderHttpError';
    this.spendCap = opts.spendCap === true;
    this.permanent = PERMANENT_PROVIDER_STATUSES.has(status) || this.spendCap;
  }
}

export function isPermanentProviderError(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && err.permanent;
}
