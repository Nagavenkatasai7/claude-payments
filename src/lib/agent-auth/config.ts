import { AGENT_SCOPES, mcpResourceUrl, type AgentScope } from './contract';

// agent-auth config — the fixed policy of the AI-agent sign-in (Stage C1). PURE: no I/O.
//
// The authorization server lives on the customer-portal hosts (<slug>.smartremit.ai); the
// issuer is https://<host> and the MCP resource is https://<host>/api/mcp (contract.ts).

/** Authorization code lifetime (single-use, Redis, hash only). */
export const AGENT_CODE_TTL_SEC = 300;
/** Access token lifetime (Redis, hash only). */
export const AGENT_ACCESS_TTL_SEC = 3600;
/** A grant lives 30 days from its last refresh (sliding). */
export const AGENT_GRANT_TTL_MS = 30 * 24 * 3600 * 1000;
/** The consent screen's server-side ticket (binds Allow/Deny to the validated request). */
export const AGENT_CONSENT_TTL_SEC = 600;
/** How long a used code is remembered, so a replay revokes the grant it minted (RFC 6749 §4.1.2). */
export const AGENT_CODE_USED_TTL_SEC = 3600;

export const AGENT_CLIENT_NAME_MAX = 60;
export const AGENT_MAX_REDIRECT_URIS = 5;
export const AGENT_REDIRECT_URI_MAX = 512;
export const AGENT_STATE_MAX = 512;

export const ACCESS_TOKEN_PREFIX = 'sra_';
export const REFRESH_TOKEN_PREFIX = 'srr_';
export const CLIENT_SECRET_PREFIX = 'src_';

export type AgentAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export const AGENT_AUTH_METHODS: readonly AgentAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

/** Per-IP limits on the public endpoints (checkIpRateLimit; fail-open like the others). */
export const AGENT_IP_LIMITS = {
  register: { scope: 'agentreg', limit: 10, windowSec: 3600 },
  token: { scope: 'agenttok', limit: 60, windowSec: 60 },
  authorize: { scope: 'agentauthz', limit: 30, windowSec: 60 },
  revoke: { scope: 'agentrev', limit: 60, windowSec: 60 },
} as const;

/** Client and grant ids: a prefix plus 22 base64url characters (16 random bytes). */
export const CLIENT_ID_RE = /^agc_[A-Za-z0-9_-]{22}$/;
export const GRANT_ID_RE = /^agg_[A-Za-z0-9_-]{22}$/;

/** The portal host of a site slug (site-host.ts SITE_HOST). */
export const siteHostFor = (slug: string) => `${slug.toLowerCase()}.smartremit.ai`;

export const issuerFor = (host: string) => `https://${host.toLowerCase()}`;

/**
 * A scope parameter → the granted scopes in canonical order, or null when it names anything
 * unknown or nothing at all. Absent (null/undefined) = all C1 scopes.
 */
export function parseScope(raw: string | null | undefined): AgentScope[] | null {
  if (raw === null || raw === undefined) return [...AGENT_SCOPES];
  const parts = raw.split(' ').filter((p) => p !== '');
  if (parts.length === 0) return null;
  const known = new Set<string>(AGENT_SCOPES);
  if (!parts.every((p) => known.has(p))) return null;
  const want = new Set(parts);
  return AGENT_SCOPES.filter((s) => want.has(s));
}

/** RFC 8414 authorization server metadata for this host. Not OIDC: no openid-configuration. */
export function authorizationServerMetadata(host: string) {
  const iss = issuerFor(host);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    scopes_supported: [...AGENT_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: [...AGENT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AGENT_AUTH_METHODS],
    code_challenge_methods_supported: ['S256'],
    // RFC 9207: every authorization response carries `iss`.
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 protected resource metadata for the MCP endpoint of this host. */
export function protectedResourceMetadata(host: string) {
  return {
    resource: mcpResourceUrl(host),
    authorization_servers: [issuerFor(host)],
    scopes_supported: [...AGENT_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'SmartRemit',
  };
}
