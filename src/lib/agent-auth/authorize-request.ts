import { AGENT_STATE_MAX, CLIENT_ID_RE, parseScope } from './config';
import { isCodeChallenge } from './pkce';
import { checkRedirectUri } from './redirect-uri';
import type { AgentScope } from './contract';

// The /oauth/authorize request (OAuth 2.1 + RFC 8707 + PKCE S256). PURE.
//
// Error handling follows RFC 6749 §4.1.2.1: an unknown client or a redirect_uri that is not
// EXACTLY one the client registered is SHOWN to the customer and never redirected (no open
// redirect). Every other error goes back to the validated redirect_uri.

export interface AuthorizeParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  scope: string | null;
  state: string | null;
  resource: string | null;
}

/** The query keys, in the canonical order authorizeQueryString writes them. */
const KEYS: ReadonlyArray<[keyof AuthorizeParams, string]> = [
  ['responseType', 'response_type'],
  ['clientId', 'client_id'],
  ['redirectUri', 'redirect_uri'],
  ['codeChallenge', 'code_challenge'],
  ['codeChallengeMethod', 'code_challenge_method'],
  ['scope', 'scope'],
  ['state', 'state'],
  ['resource', 'resource'],
];
const KNOWN = new Set(KEYS.map(([, k]) => k));

/** The parameters, or null when any of them appears more than once (RFC 6749 §3.1). Unknown keys are ignored. */
export function readAuthorizeParams(sp: URLSearchParams): AuthorizeParams | null {
  const out = {} as AuthorizeParams;
  for (const [field, key] of KEYS) {
    const all = sp.getAll(key);
    if (all.length > 1) return null;
    out[field] = all.length === 1 ? all[0] : null;
  }
  return out;
}

export interface ValidAuthorize {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: AgentScope[];
  state: string | null;
  resource: string;
}

export type AuthorizeError = 'invalid_request' | 'unsupported_response_type' | 'invalid_scope' | 'invalid_target';

export type AuthorizeCheck =
  | { ok: true; req: ValidAuthorize }
  | { ok: false; kind: 'show'; error: 'invalid_client' | 'invalid_redirect_uri' }
  | { ok: false; kind: 'redirect'; error: AuthorizeError; redirectUri: string; state: string | null };

/** VSCHAR (RFC 6749 appendix A): printable ASCII including space. */
const isState = (s: string) => s.length <= AGENT_STATE_MAX && /^[\x20-\x7E]*$/.test(s);

export function checkAuthorizeRequest(
  p: AuthorizeParams,
  ctx: { client: { id: string; redirectUris: readonly string[] } | null; resource: string },
): AuthorizeCheck {
  if (!ctx.client || p.clientId !== ctx.client.id) return { ok: false, kind: 'show', error: 'invalid_client' };
  if (p.redirectUri === null || !ctx.client.redirectUris.includes(p.redirectUri)) {
    return { ok: false, kind: 'show', error: 'invalid_redirect_uri' };
  }
  const redirectUri = p.redirectUri;
  const stateOk = p.state === null || isState(p.state);
  const fail = (error: AuthorizeError): AuthorizeCheck => ({ ok: false, kind: 'redirect', error, redirectUri, state: stateOk ? p.state : null });
  if (!stateOk) return fail('invalid_request');
  if (p.responseType !== 'code') return fail('unsupported_response_type');
  if (p.codeChallengeMethod !== 'S256' || !isCodeChallenge(p.codeChallenge)) return fail('invalid_request');
  const scopes = parseScope(p.scope);
  if (!scopes) return fail('invalid_scope');
  if (p.resource === null || p.resource !== ctx.resource) return fail('invalid_target');
  return {
    ok: true,
    req: { clientId: ctx.client.id, redirectUri, codeChallenge: p.codeChallenge as string, scopes, state: p.state, resource: p.resource },
  };
}

/** The canonical query string of a parameter set (fixed key order, absent keys left out). */
export function authorizeQueryString(p: AuthorizeParams): string {
  const sp = new URLSearchParams();
  for (const [field, key] of KEYS) {
    const v = p[field];
    if (v !== null) sp.set(key, v);
  }
  return sp.toString();
}

const NEXT_MAX = 4096;

/**
 * The sign-in / step-up return path for an authorize request (portal-auth safePortalNext): a
 * same-host `/oauth/authorize?…` whose parameters are well formed, re-serialized canonically.
 * Shape only (the client and its redirect URIs are checked again when the path is used). Anything
 * else → null.
 */
export function safeAuthorizeNext(next: unknown): string | null {
  if (typeof next !== 'string' || next.length > NEXT_MAX || !next.startsWith('/oauth/authorize?')) return null;
  if (!/^[\x21-\x7E]+$/.test(next) || next.includes('#') || next.includes('\\')) return null;
  const query = next.slice('/oauth/authorize?'.length);
  const sp = new URLSearchParams(query);
  for (const k of sp.keys()) if (!KNOWN.has(k)) return null;
  const p = readAuthorizeParams(sp);
  if (!p) return null;
  if (p.responseType !== 'code' || p.codeChallengeMethod !== 'S256') return null;
  if (p.clientId === null || !CLIENT_ID_RE.test(p.clientId)) return null;
  if (!checkRedirectUri(p.redirectUri) || !isCodeChallenge(p.codeChallenge)) return null;
  if (p.resource === null || !/^https:\/\/[a-z0-9.-]+\/api\/mcp$/.test(p.resource)) return null;
  if (p.scope !== null && parseScope(p.scope) === null) return null;
  if (p.state !== null && !isState(p.state)) return null;
  const canonical = `/oauth/authorize?${authorizeQueryString(p)}`;
  return canonical.length <= NEXT_MAX ? canonical : null;
}
