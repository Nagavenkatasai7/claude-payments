import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents, agentGrants } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';
import { createAgentOAuthRepo } from '@/db/repos/agent-oauth-repo';
import { createAgentTokenStore } from '@/lib/agent-auth/stores';
import { recordAgentEvent } from '@/lib/agent-auth/audit';
import { handleRegister, handleRevoke, handleToken, type AgentServerDeps, type HostCtx } from '@/lib/agent-auth/server';
import { handleAuthorizeGet, handleAuthorizePost, type AuthorizeDeps, type AgentSession } from '@/lib/agent-auth/authorize-flow';
import { createAgentAuth } from '@/lib/agent-auth/service';
import { buildCsp } from '@/lib/csp';

// Stage C1: the OAuth 2.1 flow end to end against a real Postgres (PGlite) and a fake Redis:
// registration → authorize (sign-in, step-up, consent) → token (PKCE) → refresh (rotation and
// reuse detection) → revoke, plus the access-token check the MCP endpoint relies on.

const HOST = 'send.smartremit.ai';
const ISS = `https://${HOST}`;
const RESOURCE = `${ISS}/api/mcp`;
const CTX: HostCtx = { partnerId: 'default', host: HOST };
const PHONE = '15551230000';
const PEPPER = 'test-pepper';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let db: Db;
let redis: FakeRedis;
let clock: number;
let gate: { tools: boolean; demo: Set<string> };
let session: AgentSession | null;
let limitedScopes: Set<string>;

function deps(): AuthorizeDeps {
  const repo = createAgentOAuthRepo(db);
  return {
    repo,
    store: createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER }),
    now: () => clock,
    pepper: PEPPER,
    toolsOn: async () => gate.tools,
    gateOpen: async (_p, phone) => gate.tools && gate.demo.has(phone),
    audit: (e) => recordAgentEvent(db, e),
    limited: async (name) => limitedScopes.has(name),
    session: async () => session,
    isDev: false,
  };
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISS}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });

async function register(body: Record<string, unknown> = { redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' }, ctx = CTX) {
  const res = await handleRegister(
    new Request(`https://${ctx.host}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    ctx,
    deps(),
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

function authorizeUrl(clientId: string, over: Record<string, string | null> = {}) {
  const sp = new URLSearchParams();
  const p: Record<string, string | null> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: RESOURCE,
    ...over,
  };
  for (const [k, v] of Object.entries(p)) if (v !== null) sp.set(k, v);
  return `${ISS}/oauth/authorize?${sp.toString()}`;
}

/** GET the consent screen and return its ticket (asserts it rendered). */
async function consentTicket(clientId: string): Promise<{ ticket: string; res: Response }> {
  const res = await handleAuthorizeGet(new Request(authorizeUrl(clientId)), CTX, deps());
  expect(res.status).toBe(200);
  const html = await res.clone().text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
  expect(ticket).toBeTruthy();
  return { ticket: ticket!, res };
}

async function decide(ticket: string, decision: 'allow' | 'deny', origin = ISS) {
  return handleAuthorizePost(
    new Request(`${ISS}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams({ ticket, decision }).toString(),
    }),
    CTX,
    deps(),
  );
}

/** Register, consent, and return the authorization code. */
async function getCode(): Promise<{ clientId: string; code: string }> {
  const { json } = await register();
  const clientId = json.client_id as string;
  const { ticket } = await consentTicket(clientId);
  const res = await decide(ticket, 'allow');
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get('location')!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('st-1');
  expect(loc.searchParams.get('iss')).toBe(ISS);
  return { clientId, code: loc.searchParams.get('code')! };
}

async function exchange(clientId: string, code: string, over: Record<string, string> = {}) {
  const res = await handleToken(
    form({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE, ...over }),
    CTX,
    deps(),
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

async function refresh(clientId: string, refreshToken: string, over: Record<string, string> = {}) {
  const res = await handleToken(form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE, ...over }), CTX, deps());
  return { res, json: (await res.json()) as Record<string, unknown> };
}

const agentRows = async (action: string) =>
  db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.actorType, 'agent')));

describe('agent OAuth flow', { retry: 0 }, () => {
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pb');
    redis = fakeRedis();
    clock = Date.now();
    gate = { tools: true, demo: new Set([PHONE]) };
    session = { phone: PHONE, sid: 'sid-1', fresh: true };
    limitedScopes = new Set();
  });

  describe('registration', () => {
    it('a public client gets an id and no secret; CORS is open', async () => {
      const { res, json } = await register();
      expect(res.status).toBe(201);
      expect(json.client_id).toMatch(/^agc_[A-Za-z0-9_-]{22}$/);
      expect(json.client_secret).toBeUndefined();
      expect(json).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
    it('a confidential client gets a secret once; only its hash is stored', async () => {
      const { json } = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' });
      expect(json.client_secret).toMatch(/^src_/);
      const row = await createAgentOAuthRepo(db).getClient('default', json.client_id as string);
      expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.secretHash).not.toContain(json.client_secret as string);
    });
    it('bad metadata is a 400 with the RFC 7591 code', async () => {
      const { res, json } = await register({ redirect_uris: ['http://evil.example/cb'] });
      expect(res.status).toBe(400);
      expect(json.error).toBe('invalid_redirect_uri');
    });
    it('a non-JSON or oversized body is invalid_client_metadata', async () => {
      const r1 = await handleRegister(new Request(`${ISS}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), CTX, deps());
      expect(r1.status).toBe(400);
      const big = JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x', pad: 'y'.repeat(20_000) });
      const r2 = await handleRegister(new Request(`${ISS}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }), CTX, deps());
      expect(r2.status).toBe(400);
    });
    it('the per-IP limit answers 429', async () => {
      limitedScopes.add('register');
      const { res } = await register();
      expect(res.status).toBe(429);
    });
    it('flag off: no registration (fail closed)', async () => {
      gate.tools = false;
      const { res, json } = await register();
      expect(res.status).toBe(403);
      expect(json.error).toBe('access_denied');
    });
  });

  describe('authorize', () => {
    it('signed out → the portal sign-in with a safe next back to the canonical request', async () => {
      const { json } = await register();
      session = null;
      const res = await handleAuthorizeGet(new Request(`${authorizeUrl(json.client_id as string)}&prompt=consent`), CTX, deps());
      expect(res.status).toBe(303);
      const loc = res.headers.get('location')!;
      expect(loc.startsWith('/portal/login?next=')).toBe(true);
      const next = new URL(loc, ISS).searchParams.get('next')!;
      expect(next.startsWith('/oauth/authorize?response_type=code&client_id=')).toBe(true);
      expect(next).not.toContain('prompt');
      const { safePortalNext } = await import('@/lib/portal-auth');
      expect(safePortalNext(next)).toBe(next);
    });
    it('a stale session (no code proof in 15 minutes) → the portal step-up', async () => {
      const { json } = await register();
      session = { phone: PHONE, sid: 'sid-1', fresh: false };
      const res = await handleAuthorizeGet(new Request(authorizeUrl(json.client_id as string)), CTX, deps());
      expect(res.status).toBe(303);
      expect(res.headers.get('location')!.startsWith('/portal/verify?next=%2Foauth%2Fauthorize%3F')).toBe(true);
    });
    it('the consent page: escaped name, no-store, and a CSP whose form-action allows ONLY the validated redirect origin', async () => {
      const { json } = await register({ redirect_uris: [REDIRECT, 'http://localhost:6274/cb'], client_name: '<b>Evil</b> & co', token_endpoint_auth_method: 'none' });
      const { res } = await consentTicket(json.client_id as string);
      const html = await res.text();
      expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; co');
      expect(html).not.toContain('<b>Evil</b>');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toBe(buildCsp({ isDev: false }).replace("form-action 'self'", "form-action 'self' https://claude.ai"));
      expect(csp).not.toContain('localhost');
      expect(res.headers.get('content-type')).toContain('text/html');
    });
    it('every other authorize response carries the site CSP unchanged (form-action self only)', async () => {
      session = null;
      const { json } = await register();
      const res = await handleAuthorizeGet(new Request(authorizeUrl(json.client_id as string)), CTX, deps());
      expect(res.headers.get('content-security-policy')).toBe(buildCsp({ isDev: false }));
      const bad = await handleAuthorizeGet(new Request(`${ISS}/oauth/authorize?client_id=x`), CTX, deps());
      expect(bad.status).toBe(400);
      expect(bad.headers.get('content-security-policy')).toBe(buildCsp({ isDev: false }));
    });
    it('a redirect_uri mismatch is shown, never redirected', async () => {
      const { json } = await register();
      const res = await handleAuthorizeGet(new Request(authorizeUrl(json.client_id as string, { redirect_uri: 'https://evil.example/cb' })), CTX, deps());
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('This link does not work');
    });
    it('another tenant\'s client is unknown here', async () => {
      const { json } = await register(undefined, { partnerId: 'pb', host: 'acme.smartremit.ai' });
      const res = await handleAuthorizeGet(new Request(authorizeUrl(json.client_id as string)), CTX, deps());
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });
    it('missing PKCE / wrong resource redirect back with the error, the state and iss', async () => {
      const { json } = await register();
      const id = json.client_id as string;
      for (const [over, error] of [
        [{ code_challenge: null }, 'invalid_request'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ resource: 'https://acme.smartremit.ai/api/mcp' }, 'invalid_target'],
        [{ resource: null }, 'invalid_target'],
        [{ scope: 'transfers:prepare' }, 'invalid_scope'],
      ] as const) {
        const res = await handleAuthorizeGet(new Request(authorizeUrl(id, over)), CTX, deps());
        expect(res.status).toBe(303);
        const loc = new URL(res.headers.get('location')!);
        expect({ error: loc.searchParams.get('error'), state: loc.searchParams.get('state'), iss: loc.searchParams.get('iss') }).toEqual({ error, state: 'st-1', iss: ISS });
      }
    });
    it('flag off → "This is not available", before any sign-in', async () => {
      const { json } = await register();
      gate.tools = false;
      session = null;
      const res = await handleAuthorizeGet(new Request(authorizeUrl(json.client_id as string)), CTX, deps());
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('This is not available');
    });
    it('a phone outside demo mode sees the same "not available" page', async () => {
      const { json } = await register();
      gate.demo = new Set();
      const res = await handleAuthorizeGet(new Request(authorizeUrl(json.client_id as string)), CTX, deps());
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('This is not available');
    });
    it('Deny → access_denied back to the app with state and iss; no code', async () => {
      const { json } = await register();
      const { ticket } = await consentTicket(json.client_id as string);
      const res = await decide(ticket, 'deny');
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.searchParams.get('error')).toBe('access_denied');
      expect(loc.searchParams.get('state')).toBe('st-1');
      expect(loc.searchParams.get('iss')).toBe(ISS);
      expect(loc.searchParams.get('code')).toBeNull();
    });
    it('the consent POST: another origin, a reused ticket, or another session is refused', async () => {
      const { json } = await register();
      const { ticket } = await consentTicket(json.client_id as string);
      expect((await decide(ticket, 'allow', 'https://evil.example')).status).toBe(403);
      // The cross-origin attempt did not consume the ticket.
      session = { phone: PHONE, sid: 'sid-OTHER', fresh: true };
      const other = await decide(ticket, 'allow');
      expect(other.status).toBe(400);
      expect(other.headers.get('location')).toBeNull();
      session = { phone: PHONE, sid: 'sid-1', fresh: true };
      expect((await decide(ticket, 'allow')).status).toBe(400); // consumed above: single use
    });
    it('the gate is checked again on Allow', async () => {
      const { json } = await register();
      const { ticket } = await consentTicket(json.client_id as string);
      gate.tools = false;
      const res = await decide(ticket, 'allow');
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    });
    it('the per-IP limit answers 429', async () => {
      const { json } = await register();
      limitedScopes.add('authorize');
      expect((await handleAuthorizeGet(new Request(authorizeUrl(json.client_id as string)), CTX, deps())).status).toBe(429);
    });
  });

  describe('token', () => {
    it('authorization_code + PKCE → tokens; the grant row and the audit row exist; hashes only', async () => {
      const { clientId, code } = await getCode();
      const { res, json } = await exchange(clientId, code);
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'quotes:read recipients:read transfers:read' });
      expect(json.access_token).toMatch(/^sra_/);
      expect(json.refresh_token).toMatch(/^srr_/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const [g] = await db.select().from(agentGrants);
      expect(g).toMatchObject({ partnerId: 'default', phone: PHONE, clientId, revokedAt: null });
      expect(g.refreshHash).not.toContain(json.refresh_token as string);
      for (const v of redis.dump.values()) {
        expect(v).not.toContain(json.access_token as string);
        expect(v).not.toContain(code);
      }
      for (const k of redis.dump.keys()) {
        expect(k).not.toContain(json.access_token as string);
        expect(k).not.toContain(code);
      }
      const created = await agentRows('agent.grant.created');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ partnerId: 'default', actor: `agent:${clientId}` });
      expect(JSON.stringify(created[0])).not.toContain(PHONE);
    });
    it('a wrong PKCE verifier fails, and burns the code', async () => {
      const { clientId, code } = await getCode();
      const bad = await exchange(clientId, code, { code_verifier: `${VERIFIER.slice(0, -1)}Y` });
      expect(bad.res.status).toBe(400);
      expect(bad.json.error).toBe('invalid_grant');
      expect((await exchange(clientId, code)).json.error).toBe('invalid_grant');
    });
    it('a missing verifier is invalid_request', async () => {
      const { clientId, code } = await getCode();
      const { json } = await exchange(clientId, code, { code_verifier: '' });
      expect(json.error).toBe('invalid_request');
    });
    it('a redirect_uri mismatch at the token endpoint fails', async () => {
      const { clientId, code } = await getCode();
      const { json } = await exchange(clientId, code, { redirect_uri: 'https://claude.ai/other' });
      expect(json.error).toBe('invalid_grant');
    });
    it('a code is single-use: the replay fails AND revokes the grant it minted', async () => {
      const { clientId, code } = await getCode();
      const first = await exchange(clientId, code);
      expect(first.res.status).toBe(200);
      const again = await exchange(clientId, code);
      expect(again.json.error).toBe('invalid_grant');
      const [g] = await db.select().from(agentGrants);
      expect(g.revokedReason).toBe('code_reuse');
      const auth = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER }), now: () => clock, redis, gateOpen: async () => true, audit: async () => {} });
      expect(await auth.verifyAccessToken(first.json.access_token as string, RESOURCE)).toEqual({ ok: false, reason: 'invalid' });
    });
    it('an expired code fails', async () => {
      const { clientId, code } = await getCode();
      clock += 301_000;
      expect((await exchange(clientId, code)).json.error).toBe('invalid_grant');
    });
    it('a code minted for another client fails for this one', async () => {
      const { code } = await getCode();
      const other = (await register()).json.client_id as string;
      expect((await exchange(other, code)).json.error).toBe('invalid_grant');
    });
    it('the resource must be this host\'s MCP URL (invalid_target)', async () => {
      const { clientId, code } = await getCode();
      expect((await exchange(clientId, code, { resource: 'https://acme.smartremit.ai/api/mcp' })).json.error).toBe('invalid_target');
      expect((await exchange(clientId, code)).res.status).toBe(200); // the refused try did not consume the code
    });
    it('another tenant cannot redeem the code (its host is another partner)', async () => {
      const { clientId, code } = await getCode();
      const res = await handleToken(
        form({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: 'https://acme.smartremit.ai/api/mcp' }),
        { partnerId: 'pb', host: 'acme.smartremit.ai' },
        deps(),
      );
      expect(res.status).toBe(401); // the client is not even known on that tenant
    });
    it('flag off at the token endpoint: no new grant (access_denied)', async () => {
      const { clientId, code } = await getCode();
      gate.tools = false;
      const { res, json } = await exchange(clientId, code);
      expect(res.status).toBe(400);
      expect(json.error).toBe('access_denied');
      expect(await db.select().from(agentGrants)).toHaveLength(0);
    });
    it('an unknown client is a 401 invalid_client', async () => {
      const { code } = await getCode();
      const { res, json } = await exchange('agc_ZZZZZZZZZZZZZZZZZZZZZZ', code);
      expect(res.status).toBe(401);
      expect(json.error).toBe('invalid_client');
    });
    it('a confidential client must present its secret (post or basic)', async () => {
      const { json: reg } = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
      const clientId = reg.client_id as string;
      const secret = reg.client_secret as string;
      const mint = async () => {
        const { ticket } = await consentTicket(clientId);
        return new URL((await decide(ticket, 'allow')).headers.get('location')!).searchParams.get('code')!;
      };
      const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE };
      const noSecret = await handleToken(form({ ...base, client_id: clientId, code: await mint() }), CTX, deps());
      expect(noSecret.status).toBe(401);
      const wrong = await handleToken(form({ ...base, code: await mint() }, { authorization: `Basic ${Buffer.from(`${clientId}:nope`).toString('base64')}` }), CTX, deps());
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('www-authenticate')).toMatch(/^Basic/);
      const ok = await handleToken(form({ ...base, code: await mint() }, { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` }), CTX, deps());
      expect(ok.status).toBe(200);
      const viaPost = await handleToken(form({ ...base, client_id: clientId, client_secret: secret, code: await mint() }), CTX, deps());
      expect(viaPost.status).toBe(200);
    });
    it('an unsupported grant type', async () => {
      const { json } = await register();
      const res = await handleToken(form({ grant_type: 'client_credentials', client_id: json.client_id as string }), CTX, deps());
      expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
    });
    it('a body that is not a form is invalid_request', async () => {
      const res = await handleToken(new Request(`${ISS}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), CTX, deps());
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    });
    it('the per-IP limit answers 429', async () => {
      limitedScopes.add('token');
      const res = await handleToken(form({ grant_type: 'refresh_token' }), CTX, deps());
      expect(res.status).toBe(429);
    });
  });

  describe('refresh', () => {
    async function tokens() {
      const { clientId, code } = await getCode();
      const { json } = await exchange(clientId, code);
      return { clientId, access: json.access_token as string, refresh: json.refresh_token as string };
    }
    it('rotates: a new refresh token each time, the old one stops working, the expiry slides', async () => {
      const t = await tokens();
      clock += 10 * 24 * 3600 * 1000;
      const r1 = await refresh(t.clientId, t.refresh);
      expect(r1.res.status).toBe(200);
      expect(r1.json.refresh_token).not.toBe(t.refresh);
      const [g] = await db.select().from(agentGrants);
      expect(g.expiresAt.getTime()).toBe(clock + 30 * 24 * 3600 * 1000);
      const r2 = await refresh(t.clientId, r1.json.refresh_token as string);
      expect(r2.res.status).toBe(200);
    });
    it('a rotated refresh token presented again = theft: the grant is revoked, every token dies', async () => {
      const t = await tokens();
      const r1 = await refresh(t.clientId, t.refresh);
      const replay = await refresh(t.clientId, t.refresh);
      expect(replay.json.error).toBe('invalid_grant');
      const [g] = await db.select().from(agentGrants);
      expect(g.revokedReason).toBe('theft');
      expect((await refresh(t.clientId, r1.json.refresh_token as string)).json.error).toBe('invalid_grant');
      const auth = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER }), now: () => clock, redis, gateOpen: async () => true, audit: async () => {} });
      expect(await auth.verifyAccessToken(r1.json.access_token as string, RESOURCE)).toEqual({ ok: false, reason: 'invalid' });
      const revoked = await agentRows('agent.grant.revoked');
      expect(revoked.map((r) => (r.meta as { reason: string }).reason)).toEqual(['theft']);
    });
    it('another client presenting the refresh token fails', async () => {
      const t = await tokens();
      const other = (await register()).json.client_id as string;
      expect((await refresh(other, t.refresh)).json.error).toBe('invalid_grant');
    });
    it('a narrower scope on refresh is honoured; a wider one is invalid_scope', async () => {
      const t = await tokens();
      const narrow = await refresh(t.clientId, t.refresh, { scope: 'quotes:read' });
      expect(narrow.json.scope).toBe('quotes:read');
      expect((await refresh(t.clientId, narrow.json.refresh_token as string, { scope: 'quotes:read transfers:prepare' })).json.error).toBe('invalid_scope');
    });
    it('an expired grant cannot refresh', async () => {
      const t = await tokens();
      clock += 31 * 24 * 3600 * 1000;
      expect((await refresh(t.clientId, t.refresh)).json.error).toBe('invalid_grant');
    });
    it('a partner API key or garbage is never a refresh token', async () => {
      const t = await tokens();
      expect((await refresh(t.clientId, 'sr_live_abc')).json.error).toBe('invalid_grant');
    });
  });

  describe('revoke (RFC 7009)', () => {
    it('revoking the refresh token revokes the grant; the access token stops verifying', async () => {
      const { clientId, code } = await getCode();
      const { json } = await exchange(clientId, code);
      const res = await handleRevoke(form({ token: json.refresh_token as string, client_id: clientId }), CTX, deps());
      expect(res.status).toBe(200);
      const [g] = await db.select().from(agentGrants);
      expect(g.revokedReason).toBe('client');
      const auth = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER }), now: () => clock, redis, gateOpen: async () => true, audit: async () => {} });
      expect((await auth.verifyAccessToken(json.access_token as string, RESOURCE)).ok).toBe(false);
    });
    it('revoking an access token drops it; an unknown token is still 200', async () => {
      const { clientId, code } = await getCode();
      const { json } = await exchange(clientId, code);
      expect((await handleRevoke(form({ token: json.access_token as string, client_id: clientId }), CTX, deps())).status).toBe(200);
      const auth = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER }), now: () => clock, redis, gateOpen: async () => true, audit: async () => {} });
      expect((await auth.verifyAccessToken(json.access_token as string, RESOURCE)).ok).toBe(false);
      expect((await handleRevoke(form({ token: 'srr_nothing', client_id: clientId }), CTX, deps())).status).toBe(200);
    });
    it('another client cannot revoke my tokens', async () => {
      const { clientId, code } = await getCode();
      const { json } = await exchange(clientId, code);
      const other = (await register()).json.client_id as string;
      expect((await handleRevoke(form({ token: json.refresh_token as string, client_id: other }), CTX, deps())).status).toBe(200);
      const [g] = await db.select().from(agentGrants);
      expect(g.revokedAt).toBeNull();
    });
  });

  describe('verifyAccessToken (the MCP endpoint check)', () => {
    const auth = () =>
      createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER }), now: () => clock, redis, gateOpen: async () => true, audit: async () => {} });

    async function tokens() {
      const { clientId, code } = await getCode();
      const { json } = await exchange(clientId, code);
      return { clientId, access: json.access_token as string };
    }
    it('a good token → the principal from the grant (tenant, phone, client name, scopes)', async () => {
      const t = await tokens();
      const r = await auth().verifyAccessToken(t.access, RESOURCE);
      expect(r).toEqual({
        ok: true,
        principal: { grantId: expect.stringMatching(/^agg_/), partnerId: 'default', phone: PHONE, clientId: t.clientId, clientName: 'Claude', scopes: ['quotes:read', 'recipients:read', 'transfers:read'] },
      });
    });
    it('missing / garbage / a partner API key', async () => {
      expect(await auth().verifyAccessToken(null, RESOURCE)).toEqual({ ok: false, reason: 'missing' });
      expect(await auth().verifyAccessToken('', RESOURCE)).toEqual({ ok: false, reason: 'missing' });
      expect(await auth().verifyAccessToken('sr_live_abc', RESOURCE)).toEqual({ ok: false, reason: 'invalid' });
      expect(await auth().verifyAccessToken('sra_nope', RESOURCE)).toEqual({ ok: false, reason: 'invalid' });
    });
    it('a token for another host\'s resource fails', async () => {
      const t = await tokens();
      expect(await auth().verifyAccessToken(t.access, 'https://acme.smartremit.ai/api/mcp')).toEqual({ ok: false, reason: 'invalid' });
    });
    it('an expired access token fails', async () => {
      const t = await tokens();
      clock += 3601_000;
      expect((await auth().verifyAccessToken(t.access, RESOURCE)).ok).toBe(false);
    });
    it('another tenant\'s grant never verifies (a record naming tenant A cannot reach tenant B\'s grant)', async () => {
      const t = await tokens();
      const store = createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER });
      const real = await store.readAccess(t.access);
      // Move the grant to tenant pb (as if the token record and the grant disagreed on the tenant).
      await db.update(agentGrants).set({ partnerId: 'pb' }).where(eq(agentGrants.id, real!.grantId));
      expect((await auth().verifyAccessToken(t.access, RESOURCE)).ok).toBe(false);
      // A forged record that names pb for a token: the grant join requires the client on pb too.
      const forged = await store.issueAccess({ ...real!, partnerId: 'pb' });
      expect((await auth().verifyAccessToken(forged.token, RESOURCE)).ok).toBe(false);
    });
    it('a disconnect (revoked grant) stops the token at once', async () => {
      const t = await tokens();
      const [g] = await db.select().from(agentGrants);
      await createAgentOAuthRepo(db).revokeCustomerGrant('default', PHONE, g.id, new Date(clock));
      expect((await auth().verifyAccessToken(t.access, RESOURCE)).ok).toBe(false);
    });
    it('a store error is invalid, never a throw', async () => {
      const broken = createAgentAuth({
        repo: createAgentOAuthRepo(db),
        store: { readAccess: async () => { throw new Error('redis down'); } } as never,
        now: () => clock,
        redis,
        gateOpen: async () => true,
        audit: async () => {},
      });
      expect(await broken.verifyAccessToken('sra_x', RESOURCE)).toEqual({ ok: false, reason: 'invalid' });
    });
    it('toolsActive is the gate and fails closed', async () => {
      const on = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis), now: () => clock, redis, gateOpen: async () => true, audit: async () => {} });
      const off = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis), now: () => clock, redis, gateOpen: async () => { throw new Error('x'); }, audit: async () => {} });
      expect(await on.toolsActive('default', PHONE)).toBe(true);
      expect(await off.toolsActive('default', PHONE)).toBe(false);
    });
    it('recordToolCall writes one agent audit row with only tool, client and outcome; never throws', async () => {
      const t = await tokens();
      const a = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis, { now: () => clock, pepper: PEPPER }), now: () => clock, redis, gateOpen: async () => true, audit: (e) => recordAgentEvent(db, e) });
      const r = await a.verifyAccessToken(t.access, RESOURCE);
      if (!r.ok) throw new Error('expected ok');
      await a.recordToolCall(r.principal, 'get_quote', 'ok');
      const rows = await agentRows('agent.tool.called');
      expect(rows).toHaveLength(1);
      expect(rows[0].meta).toEqual({ tool: 'get_quote', clientId: t.clientId, outcome: 'ok' });
      const throwing = createAgentAuth({ repo: createAgentOAuthRepo(db), store: createAgentTokenStore(redis), now: () => clock, redis, gateOpen: async () => true, audit: async () => { throw new Error('db down'); } });
      await expect(throwing.recordToolCall(r.principal, 'get_quote', 'error')).resolves.toBeUndefined();
    });
  });
});
