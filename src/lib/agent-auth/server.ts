import type { AgentOAuthRepo, AgentClientRow } from '@/db/repos/agent-oauth-repo';
import type { PartnerId } from '@/lib/types';
import { mcpResourceUrl, type AgentScope } from './contract';
import {
  AGENT_GRANT_TTL_MS,
  AGENT_IP_LIMITS,
  AGENT_REGISTER_BODY_MAX,
  CLIENT_ID_RE,
  CLIENT_SECRET_PREFIX,
  REFRESH_TOKEN_PREFIX,
  ACCESS_TOKEN_PREFIX,
  requestedScopes,
} from './config';
import type { AgentAuditInput } from './audit';
import { oauthError, oauthJson, readCapped, readForm } from './http';
import { verifyPkceS256 } from './pkce';
import { parseClientRegistration } from './registration';
import { agentSecretHash, newAgentId, newAgentSecret, sameHash } from './secrets';
import type { AgentTokenStore } from './stores';

// The AI-agent authorization server's machine endpoints (Stage C1): RFC 7591 registration,
// the token endpoint (authorization_code with PKCE S256, refresh_token with rotation and reuse
// detection) and RFC 7009 revocation. Request-scope free: the route handlers pass the host's
// tenant (requirePortalSite, never request input) and the dependencies, so every rule is
// tested here against a real Postgres.

export interface HostCtx {
  /** The tenant of the request's portal host. */
  partnerId: PartnerId;
  /** The portal host, lower case (e.g. send.smartremit.ai). */
  host: string;
}

export interface AgentServerDeps {
  repo: AgentOAuthRepo;
  store: AgentTokenStore;
  now: () => number;
  pepper: string;
  /** The `agent.tools` switch for the tenant (fails closed). */
  toolsOn(partnerId: PartnerId): Promise<boolean>;
  /** The full gate: switch AND demo-mode phone (fails closed). */
  gateOpen(partnerId: PartnerId, phone: string): Promise<boolean>;
  /** Best-effort audit row (never throws). */
  audit(e: AgentAuditInput): Promise<void>;
  /** True when this request is over the per-IP limit `name` (fail-open: false on a limiter error). */
  limited(name: keyof typeof AGENT_IP_LIMITS, req: Request): Promise<boolean>;
}

const tooMany = () => oauthError('slow_down', 'Too many requests. Try again in a minute.', 429, { 'Retry-After': '60' });

// ── Registration (RFC 7591) ─────────────────────────────────────────────────

export async function handleRegister(req: Request, ctx: HostCtx, deps: AgentServerDeps): Promise<Response> {
  if (await deps.limited('register', req)) return tooMany();
  if (!(await deps.toolsOn(ctx.partnerId))) return oauthError('access_denied', 'AI apps are not available here.', 403);
  const type = (req.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') return oauthError('invalid_client_metadata', 'The body must be application/json.');
  const text = await readCapped(req, AGENT_REGISTER_BODY_MAX);
  if (text === null) return oauthError('invalid_client_metadata', 'The body is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthError('invalid_client_metadata', 'The body is not valid JSON.');
  }
  const parsed = parseClientRegistration(body);
  if (!parsed.ok) return oauthError(parsed.error, parsed.description);
  const { name, redirectUris, authMethod } = parsed.value;
  const id = newAgentId('agc_');
  const secret = authMethod === 'none' ? null : newAgentSecret(CLIENT_SECRET_PREFIX);
  await deps.repo.insertClient({
    id,
    partnerId: ctx.partnerId,
    name,
    redirectUris,
    authMethod,
    secretHash: secret ? agentSecretHash(secret, deps.pepper) : null,
  });
  return oauthJson(
    {
      client_id: id,
      client_id_issued_at: Math.floor(deps.now() / 1000),
      ...(name ? { client_name: name } : {}),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    },
    201,
  );
}

// ── Client authentication (token and revocation endpoints) ──────────────────

type ClientAuth = { ok: true; client: AgentClientRow } | { ok: false; response: Response };

/** RFC 6749 §2.3.1 Basic credentials: base64("urlenc(id):urlenc(secret)"). null when malformed. */
function parseBasic(header: string): { id: string; secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  try {
    return { id: decodeURIComponent(decoded.slice(0, i).replace(/\+/g, ' ')), secret: decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, ' ')) };
  } catch {
    return null;
  }
}

async function authenticateClient(form: URLSearchParams, req: Request, ctx: HostCtx, deps: AgentServerDeps): Promise<ClientAuth> {
  const header = req.headers.get('authorization');
  const viaBasic = header !== null && /^basic\s/i.test(header.trim());
  const deny = () => ({
    ok: false as const,
    response: oauthError('invalid_client', 'Client authentication failed.', 401, viaBasic ? { 'WWW-Authenticate': 'Basic realm="smartremit"' } : {}),
  });
  let id = form.get('client_id');
  let secret = form.get('client_secret');
  if (viaBasic) {
    const basic = parseBasic(header!);
    if (!basic) return deny();
    if (secret !== null) return { ok: false, response: oauthError('invalid_request', 'Use one client authentication method.') };
    if (id !== null && id !== basic.id) return deny();
    id = basic.id;
    secret = basic.secret;
  }
  if (!id || !CLIENT_ID_RE.test(id)) return deny();
  const client = await deps.repo.getClient(ctx.partnerId, id);
  if (!client) return deny();
  if (client.authMethod === 'none') {
    // A public client has no secret: presenting one is a mistake, not a credential.
    if (secret) return deny();
    return { ok: true, client };
  }
  // A confidential client: its secret by POST body or Basic (equal strength), compared by hash.
  if (!secret || !client.secretHash || !sameHash(agentSecretHash(secret, deps.pepper), client.secretHash)) return deny();
  return { ok: true, client };
}

// ── Token endpoint ──────────────────────────────────────────────────────────

function tokenResponse(access: { token: string; expiresIn: number }, refresh: string, scopes: readonly AgentScope[]): Response {
  return oauthJson({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token: refresh, scope: scopes.join(' ') });
}

export async function handleToken(req: Request, ctx: HostCtx, deps: AgentServerDeps): Promise<Response> {
  if (await deps.limited('token', req)) return tooMany();
  const form = await readForm(req);
  if (!form) return oauthError('invalid_request', 'Send one application/x-www-form-urlencoded body, without repeated parameters.');
  const grantType = form.get('grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return oauthError('unsupported_grant_type');
  const auth = await authenticateClient(form, req, ctx, deps);
  if (!auth.ok) return auth.response;
  const resource = mcpResourceUrl(ctx.host);
  if (form.get('resource') !== resource) return oauthError('invalid_target', `resource must be ${resource}.`);
  return grantType === 'authorization_code' ? exchangeCode(form, auth.client, ctx, deps, resource) : refreshGrant(form, auth.client, ctx, deps, resource);
}

async function exchangeCode(form: URLSearchParams, client: AgentClientRow, ctx: HostCtx, deps: AgentServerDeps, resource: string): Promise<Response> {
  const code = form.get('code');
  const redirectUri = form.get('redirect_uri');
  const verifier = form.get('code_verifier');
  if (!code || !redirectUri || !verifier) return oauthError('invalid_request', 'code, redirect_uri and code_verifier are required.');

  const rec = await deps.store.takeCode(code);
  if (!rec) {
    // A replay of a code that was already redeemed: revoke what it minted (RFC 6749 §4.1.2).
    const used = await deps.store.usedCodeGrant(code);
    if (used && used.partnerId === ctx.partnerId) await revokeAndAudit(ctx.partnerId, used.grantId, 'code_reuse', deps);
    return oauthError('invalid_grant');
  }
  const bound =
    rec.partnerId === ctx.partnerId &&
    rec.clientId === client.id &&
    rec.redirectUri === redirectUri &&
    rec.resource === resource &&
    verifyPkceS256(verifier, rec.codeChallenge);
  if (!bound) return oauthError('invalid_grant');
  if (!(await deps.gateOpen(ctx.partnerId, rec.phone))) return oauthError('access_denied', 'SmartRemit AI tools are switched off.');

  const now = deps.now();
  const refresh = newAgentSecret(REFRESH_TOKEN_PREFIX);
  await deps.repo.insertGrant({
    id: rec.grantId,
    partnerId: ctx.partnerId,
    phone: rec.phone,
    clientId: client.id,
    scopes: rec.scopes,
    refreshHash: agentSecretHash(refresh, deps.pepper),
    now: new Date(now),
    expiresAt: new Date(now + AGENT_GRANT_TTL_MS),
  });
  await deps.store.markCodeUsed(code, { partnerId: ctx.partnerId, grantId: rec.grantId });
  const access = await deps.store.issueAccess({ grantId: rec.grantId, partnerId: ctx.partnerId, phone: rec.phone, clientId: client.id, scopes: rec.scopes, resource });
  await deps.audit({ partnerId: ctx.partnerId, phone: rec.phone, clientId: client.id, action: 'agent.grant.created', meta: { grantId: rec.grantId, scopes: rec.scopes.join(' ') } });
  return tokenResponse(access, refresh, rec.scopes);
}

async function refreshGrant(form: URLSearchParams, client: AgentClientRow, ctx: HostCtx, deps: AgentServerDeps, resource: string): Promise<Response> {
  const presented = form.get('refresh_token');
  if (!presented) return oauthError('invalid_request', 'refresh_token is required.');
  if (!presented.startsWith(REFRESH_TOKEN_PREFIX) || presented.length > 128) return oauthError('invalid_grant');
  const hash = agentSecretHash(presented, deps.pepper);
  const found = await deps.repo.findGrantByRefreshHash(ctx.partnerId, hash);
  if (!found) {
    // Older than the one rotation the grant row remembers: still theft.
    const retired = await deps.store.retiredRefreshGrant(presented).catch(() => null);
    if (retired && retired.partnerId === ctx.partnerId) await revokeAndAudit(ctx.partnerId, retired.grantId, 'theft', deps);
    return oauthError('invalid_grant');
  }
  const { grant } = found;
  // A rotated token presented again, or a token presented by another client: treat as theft.
  if (found.match === 'previous' || grant.clientId !== client.id) {
    if (!found.revoked) await revokeAndAudit(ctx.partnerId, grant.id, 'theft', deps, grant);
    return oauthError('invalid_grant');
  }
  const now = deps.now();
  if (found.revoked || grant.expiresAt.getTime() <= now) return oauthError('invalid_grant');

  let scopes: AgentScope[] = grant.scopes;
  const asked = form.get('scope');
  if (asked !== null) {
    // offline_access alone keeps the grant's scopes; a resource scope may only narrow them.
    const want = requestedScopes(asked);
    if (!want || !want.every((s) => grant.scopes.includes(s))) return oauthError('invalid_scope');
    if (want.length > 0) scopes = want;
  }
  const next = newAgentSecret(REFRESH_TOKEN_PREFIX);
  const rotated = await deps.repo.rotateRefresh(ctx.partnerId, grant.id, hash, agentSecretHash(next, deps.pepper), new Date(now), new Date(now + AGENT_GRANT_TTL_MS));
  if (!rotated) return oauthError('invalid_grant');
  await deps.store.markRefreshRetired(presented, { partnerId: ctx.partnerId, grantId: grant.id }).catch(() => undefined);
  const access = await deps.store.issueAccess({ grantId: grant.id, partnerId: ctx.partnerId, phone: grant.phone, clientId: client.id, scopes, resource });
  return tokenResponse(access, next, scopes);
}

async function revokeAndAudit(
  partnerId: PartnerId,
  grantId: string,
  reason: 'theft' | 'code_reuse' | 'client',
  deps: AgentServerDeps,
  known?: { phone: string; clientId: string },
): Promise<void> {
  const now = new Date(deps.now());
  const grant = known ?? (await deps.repo.getLiveGrant(partnerId, grantId, now));
  if (!(await deps.repo.revokeGrant(partnerId, grantId, reason, now))) return;
  if (grant) await deps.audit({ partnerId, phone: grant.phone, clientId: grant.clientId, action: 'agent.grant.revoked', meta: { grantId, reason } });
}

// ── Revocation (RFC 7009) ───────────────────────────────────────────────────

/** Always 200 for an authenticated client, whatever the token was (RFC 7009 §2.2). */
export async function handleRevoke(req: Request, ctx: HostCtx, deps: AgentServerDeps): Promise<Response> {
  if (await deps.limited('revoke', req)) return tooMany();
  const form = await readForm(req);
  if (!form) return oauthError('invalid_request', 'Send one application/x-www-form-urlencoded body, without repeated parameters.');
  const auth = await authenticateClient(form, req, ctx, deps);
  if (!auth.ok) return auth.response;
  const token = form.get('token');
  if (!token) return oauthError('invalid_request', 'token is required.');
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    const rec = await deps.store.readAccess(token);
    if (rec && rec.partnerId === ctx.partnerId && rec.clientId === auth.client.id) await deps.store.dropAccess(token);
  } else if (token.startsWith(REFRESH_TOKEN_PREFIX) && token.length <= 128) {
    const found = await deps.repo.findGrantByRefreshHash(ctx.partnerId, agentSecretHash(token, deps.pepper));
    if (found && found.match === 'current' && !found.revoked && found.grant.clientId === auth.client.id) {
      await revokeAndAudit(ctx.partnerId, found.grant.id, 'client', deps, found.grant);
    }
  }
  return oauthJson({});
}
