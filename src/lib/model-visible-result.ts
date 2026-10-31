/**
 * model-visible-result — the last gate before a tool result enters the agent's
 * history (R30, no tipping-off).
 *
 * The tools already leave these fields out of what they return. This strips
 * them again, at any depth, so a future tool or a nested record (a cap_eval, a
 * list of transfers) can never hand the model a remaining-limit figure, the EDD
 * threshold or a screening result that it could repeat to the customer.
 * The customer-facing wording for those cases lives in hold-replies.ts.
 */

/** Keys the model must never see. */
export const MODEL_HIDDEN_KEYS: ReadonlySet<string> = new Set([
  'today_remaining_usd',
  'today_used_usd',
  'remaining_today_usd',
  'edd_threshold_usd',
  'compliance_status',
  'compliance_reasons',
]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!MODEL_HIDDEN_KEYS.has(k)) out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/** A copy of a tool result without MODEL_HIDDEN_KEYS (at any depth). The input is never changed. */
export function modelVisibleResult(result: Record<string, unknown>): Record<string, unknown> {
  return strip(result) as Record<string, unknown>;
}
