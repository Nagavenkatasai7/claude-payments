import type { CallToolResult } from '@modelcontextprotocol/server';
import type { AgentAuth, AgentPrincipal, AgentToolCallExtra } from '@/lib/agent-auth';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';
import type { RedisLike } from '@/lib/store';

// Stage C1: the checks every SmartRemit MCP tool call passes before it reads anything, in order:
//  1. the per-grant rate limits (60 a minute, 600 an hour; Redis fixed windows through the shared
//     checkIpRateLimit counter, keyed by the grant id, never by a phone). A limiter error FAILS OPEN,
//     like every other limiter in the app: the gate below and the token check still hold;
//  2. the gate (agent.tools on for the tenant AND demo mode for the phone). It FAILS CLOSED: an
//     error is "off";
//  3. the tool itself; then one audit record (recordToolCall, with the draft id a prepare or
//     cancel touched, or the schedule id a schedule tool touched), best effort.
// Scope checks happen earlier, in the SDK's per-tool scope challenge (an HTTP 403 before dispatch).

export const TOOLS_OFF_MESSAGE = 'SmartRemit AI tools are switched off.';
export const RATE_LIMITED_MESSAGE = 'Too many requests from this app. Wait a minute, then try again.';
export const TOOL_FAILED_MESSAGE = 'Something went wrong on our side. Please try again later.';

/** Per-grant tool-call windows (spec item 11). Scopes are distinct, so the two budgets never share a key. */
export const MCP_GRANT_LIMITS = [
  { scope: 'mcp-grant-min', limit: 60, windowSec: 60 },
  { scope: 'mcp-grant-hour', limit: 600, windowSec: 3600 },
] as const;

/** True while the grant is inside BOTH windows. Every call counts in both. A limiter error → true (fail open). */
export async function underGrantLimits(redis: RedisLike, grantId: string, now: number = Date.now()): Promise<boolean> {
  try {
    let allowed = true;
    for (const w of MCP_GRANT_LIMITS) {
      const r = await checkIpRateLimit(redis, w.scope, grantId, { limit: w.limit, windowSec: w.windowSec, now });
      if (!r.allowed) allowed = false;
    }
    return allowed;
  } catch (err) {
    logWarn('mcp.rate-limit', 'grant limiter failed, allowing the call', { err: err instanceof Error ? err.name : 'error' });
    return true;
  }
}

/**
 * What a tool body returns: the JSON data for the AI, or a customer-safe message for a tool error.
 * `draftId` (Stage C2) names the draft a prepare or cancel touched, `scheduleId` the repeat payment
 * a schedule tool set up or changed; they go to the audit row only.
 */
export type ToolOutcome =
  | { ok: true; data: Record<string, unknown>; draftId?: string; scheduleId?: string }
  | { ok: false; message: string };

export interface GuardDeps {
  auth: AgentAuth;
  redis: RedisLike;
  now?: () => number;
}

/**
 * The result text is JSON, always: customer data (a recipient's name) goes to the AI as a JSON
 * string value, never as free text it could read as instructions.
 */
export function jsonResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Run one tool call through the rate limit, the gate and the audit record. Never throws. */
export async function runGuardedTool(
  tool: string,
  principal: AgentPrincipal,
  deps: GuardDeps,
  body: () => Promise<ToolOutcome>,
): Promise<CallToolResult> {
  let outcome: 'ok' | 'error' | 'refused';
  let result: CallToolResult;
  let extra: AgentToolCallExtra | undefined;
  if (!(await underGrantLimits(deps.redis, principal.grantId, deps.now?.()))) {
    outcome = 'refused';
    result = errorResult(RATE_LIMITED_MESSAGE);
  } else if (!(await gateOn(deps.auth, principal))) {
    outcome = 'refused';
    result = errorResult(TOOLS_OFF_MESSAGE);
  } else {
    try {
      const r = await body();
      outcome = r.ok ? 'ok' : 'error';
      result = r.ok ? jsonResult(r.data) : errorResult(r.message);
      if (r.ok && (r.draftId || r.scheduleId)) {
        extra = { ...(r.draftId ? { draftId: r.draftId } : {}), ...(r.scheduleId ? { scheduleId: r.scheduleId } : {}) };
      }
    } catch (err) {
      logWarn('mcp.tool', 'tool failed', { tool, err: err instanceof Error ? err.name : 'error' });
      outcome = 'error';
      result = errorResult(TOOL_FAILED_MESSAGE);
    }
  }
  try {
    await deps.auth.recordToolCall(principal, tool, outcome, extra);
  } catch {
    // best effort by contract; a throwing implementation must not break the call
  }
  return result;
}

async function gateOn(auth: AgentAuth, principal: AgentPrincipal): Promise<boolean> {
  try {
    return (await auth.toolsActive(principal.partnerId, principal.phone)) === true;
  } catch {
    return false; // fail closed
  }
}
