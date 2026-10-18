import type { PartnerId } from '../types';

// Stage C1: the seam between the AI-agent sign-in (src/lib/agent-auth/**) and the MCP
// endpoint (src/lib/mcp/**, src/app/api/mcp). The MCP side imports ONLY from this file, so
// either side can change its internals without touching the other. The tenant and the
// customer always come from a verified token, never from tool input.

/** The permissions a customer can grant an AI app (C2 adds 'transfers:prepare'). */
export type AgentScope = 'quotes:read' | 'recipients:read' | 'transfers:read';

export const AGENT_SCOPES: readonly AgentScope[] = ['quotes:read', 'recipients:read', 'transfers:read'];

/** Who an MCP request acts for, from a verified access token whose grant is live. */
export interface AgentPrincipal {
  grantId: string;
  partnerId: PartnerId;
  /** The customer's normalized phone (the same lookup key the rest of the app uses). */
  phone: string;
  clientId: string;
  /** The app's self-chosen name, unverified: show it only as "an app that calls itself …". */
  clientName: string;
  scopes: readonly AgentScope[];
}

export type AgentTokenCheck =
  | { ok: true; principal: AgentPrincipal }
  /** No token, unknown, expired, revoked grant, or a token for another resource: answer 401. */
  | { ok: false; reason: 'missing' | 'invalid' };

export interface AgentAuth {
  /**
   * Verify a bearer access token for `resource` (the canonical MCP URL of this host, e.g.
   * https://send.smartremit.ai/api/mcp). Checks the token hash, its expiry, its audience
   * and that the grant is still live. Never throws: a store error is `invalid`.
   */
  verifyAccessToken(token: string | null, resource: string): Promise<AgentTokenCheck>;
  /**
   * Is the AI-agent program on for this customer right now (the `agent.tools` switch for the
   * tenant AND demo mode for the phone)? FAILS CLOSED: any error is false.
   */
  toolsActive(partnerId: PartnerId, phone: string): Promise<boolean>;
  /** Record one tool call (audit row; never tool arguments). Best effort: never throws. */
  recordToolCall(principal: AgentPrincipal, tool: string, outcome: 'ok' | 'error' | 'refused'): Promise<void>;
}

/** The canonical MCP resource URL for a host ("https://<host>/api/mcp", lower-case host, no slash). */
export function mcpResourceUrl(host: string): string {
  return `https://${host.toLowerCase()}/api/mcp`;
}

/** The RFC 9728 metadata URL that a 401 from /api/mcp points to. */
export function protectedResourceMetadataUrl(host: string): string {
  return `https://${host.toLowerCase()}/.well-known/oauth-protected-resource/api/mcp`;
}
