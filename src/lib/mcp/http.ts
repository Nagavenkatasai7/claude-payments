import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { AGENT_SCOPES, mcpResourceUrl, protectedResourceMetadataUrl, type AgentPrincipal } from '@/lib/agent-auth';
import { logWarn } from '@/lib/log';
import type { PartnerId } from '@/lib/types';
import { buildMcpServer, type McpServerDeps } from './server';

// Stage C1: the HTTP face of /api/mcp (Streamable HTTP, stateless). In order:
//  1. the host must be a live customer-portal site (the route passes getPortalSite: the tenant is a
//     function of the Host alone, through the proxy-set header that getSiteTenant re-verifies). Any
//     other host, including the apex, gets a bare 404, exactly like requirePortalSite();
//  2. OPTIONS is the CORS preflight (no credentials: `*` origin, the token is a bearer header);
//  3. the per-IP outer ring (fail open);
//  4. the bearer token from the Authorization header ONLY (never a query string or a cookie),
//     verified for THIS host's resource; missing / invalid / for another tenant → 401 with the
//     RFC 9728 challenge;
//  5. the SDK's handler, given a fresh McpServer bound to the token's principal.
// createMcpHandler (dist/createMcpHandler-CfX6zgs1.d.mts:4145) serves 2026-07-28 traffic and, by
// default (`legacy: 'stateless'`, :3906-3927; dist/index.mjs:1049-1061), answers every 2025-era request (initialize with
// 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05) from a fresh instance over a stateless
// streamable HTTP transport; GET and DELETE (2025 session operations) get 405 there. It does no
// token verification: authInfo is passed through as given (:3885-3891, :4141-4144).

export interface McpSite {
  partnerId: PartnerId;
  slug: string;
}

export interface McpHttpDeps extends McpServerDeps {
  /** This request's portal site, or null (apex, portal off, partner not enabled, any error). */
  site: () => Promise<McpSite | null>;
  /** The per-IP limiter: a ready 429 response, or null to go on. Absent ⇒ no IP limit. */
  ipLimit?: () => Promise<Response | null>;
}

/** The space-separated scopes a 401 asks for (all of C1's). */
export const MCP_CHALLENGE_SCOPE = AGENT_SCOPES.join(' ');

/** A POST body over this is answered 413 by the SDK before anything is parsed (tool inputs are tiny). */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'mcp-protocol-version',
  'mcp-session-id',
  'mcp-method',
  'mcp-name',
  'last-event-id',
].join(', ');
const EXPOSE_HEADERS = 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version';

/** Copy a response with the CORS headers every /api/mcp answer carries (never credentials). */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function preflight(): Response {
  return withCors(
    new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Max-Age': '600',
      },
    }),
  );
}

/** The challenge header of spec item 13 (RFC 6750 §3; `error` only when a token was presented). */
export function mcpChallenge(host: string, reason: 'missing' | 'invalid'): string {
  const base = `Bearer resource_metadata="${protectedResourceMetadataUrl(host)}", scope="${MCP_CHALLENGE_SCOPE}"`;
  return reason === 'invalid' ? `${base}, error="invalid_token"` : base;
}

function unauthorized(host: string, reason: 'missing' | 'invalid'): Response {
  const body =
    reason === 'invalid'
      ? { error: 'invalid_token', error_description: 'The access token is missing, expired, revoked or not for this server.' }
      : { error: 'unauthorized', error_description: 'Sign in to SmartRemit to use these tools.' };
  return withCors(Response.json(body, { status: 401, headers: { 'WWW-Authenticate': mcpChallenge(host, reason) } }));
}

/** RFC 6750 b64token. */
const BEARER_RE = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;

/** The token from `Authorization: Bearer …`: null when there is no header, 'malformed' for anything else. */
export function bearerToken(headers: Headers): string | null | 'malformed' {
  const raw = headers.get('authorization');
  if (raw === null || raw.trim() === '') return null;
  const m = BEARER_RE.exec(raw);
  return m ? m[1] : 'malformed';
}

async function siteOrNull(site: McpHttpDeps['site']): Promise<McpSite | null> {
  try {
    return await site();
  } catch {
    return null; // fail closed: the same 404 as an apex host
  }
}

async function verify(deps: McpHttpDeps, token: string, resource: string): Promise<AgentPrincipal | null> {
  try {
    const check = await deps.auth.verifyAccessToken(token, resource);
    return check.ok ? check.principal : null;
  } catch {
    return null; // the contract says it never throws; an implementation that does is a refusal
  }
}

export async function handleMcpRequest(req: Request, deps: McpHttpDeps): Promise<Response> {
  const site = await siteOrNull(deps.site);
  if (!site) return new Response(null, { status: 404 });
  if (req.method === 'OPTIONS') return preflight();

  const limited = deps.ipLimit ? await deps.ipLimit() : null;
  if (limited) return withCors(limited);

  // The canonical host is rebuilt from the verified site, never copied from the request.
  const host = `${site.slug}.smartremit.ai`;
  const resource = mcpResourceUrl(host);
  const token = bearerToken(req.headers);
  if (token === null) return unauthorized(host, 'missing');
  if (token === 'malformed') return unauthorized(host, 'invalid');
  const principal = await verify(deps, token, resource);
  // A token for another tenant is refused like an unknown one (no oracle about other tenants).
  if (!principal || principal.partnerId !== site.partnerId) return unauthorized(host, 'invalid');

  const authInfo: AuthInfo = {
    token,
    clientId: principal.clientId,
    scopes: [...principal.scopes],
    resource: new URL(resource),
    // Stamped so the SDK's per-tool insufficient_scope challenge points at the same document.
    resourceMetadataUrl: protectedResourceMetadataUrl(host),
  };
  const handler = createMcpHandler(() => buildMcpServer(principal, deps), {
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
    onerror: (err) => logWarn('mcp.http', err.message, { name: err.name }),
  });
  return withCors(await handler.fetch(req, { authInfo }));
}
