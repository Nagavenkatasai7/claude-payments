import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCsp } from '@/lib/csp';
import type { PortalSite } from '@/lib/portal-site';
import { resolveSiteTheme } from '@/lib/ui/theme';

// Stage C1: the route handlers under src/app/oauth/** and src/app/.well-known/**. Each one
// resolves the tenant from the host (getPortalSite) and answers 404 off a live portal host (the
// apex, a preview, the portal off), like /portal/*. Metadata is served on a live host whatever
// the agent.tools switch says (discovery keeps working). The authorize 404 still carries a CSP,
// because next.config.ts leaves that one path out of the site CSP header.

const h = vi.hoisted(() => ({ site: null as null | PortalSite }));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));

// The routes' own deps reach no database or Redis in these cases: the client lookup is a stub (a
// public client), the per-IP limiter allows. Only the host-derived checks are under test here.
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({}) }));
vi.mock('@/lib/ip-rate-limit', () => ({ checkIpRateLimit: async () => ({ allowed: true }), clientIpFrom: () => '203.0.113.9' }));
vi.mock('@/db/repos/agent-oauth-repo', () => ({
  createAgentOAuthRepo: () => ({ getClient: async (_p: string, id: string) => ({ id, authMethod: 'none' }) }),
}));

const site = (partnerId: string, slug: string, host: string): PortalSite => ({
  partnerId,
  slug,
  host,
  brand: 'SmartRemit',
  logo: null,
  theme: resolveSiteTheme({}),
  skin: null,
});

const routes = {
  authorize: () => import('@/app/oauth/authorize/route'),
  token: () => import('@/app/oauth/token/route'),
  register: () => import('@/app/oauth/register/route'),
  revoke: () => import('@/app/oauth/revoke/route'),
  asMeta: () => import('@/app/.well-known/oauth-authorization-server/route'),
  prMeta: () => import('@/app/.well-known/oauth-protected-resource/route'),
  prMetaMcp: () => import('@/app/.well-known/oauth-protected-resource/api/mcp/route'),
};

const post = (path: string) => new Request(`https://smartremit.ai${path}`, { method: 'POST', body: '' });

describe('agent OAuth routes off a portal host (apex)', () => {
  beforeEach(() => {
    h.site = null;
  });
  it('every route answers 404 and reads nothing else', async () => {
    const a = await routes.authorize();
    const getRes = await a.GET(new Request('https://smartremit.ai/oauth/authorize?client_id=x'));
    expect(getRes.status).toBe(404);
    expect(getRes.headers.get('content-security-policy')).toBe(buildCsp({ isDev: false }));
    expect((await a.POST(post('/oauth/authorize'))).status).toBe(404);
    for (const [name, path] of [['token', '/oauth/token'], ['register', '/oauth/register'], ['revoke', '/oauth/revoke']] as const) {
      const m = await routes[name]();
      expect((await m.POST(post(path))).status).toBe(404);
      expect((await m.OPTIONS()).status).toBe(404);
    }
    for (const name of ['asMeta', 'prMeta', 'prMetaMcp'] as const) {
      const m = await routes[name]();
      expect((await m.GET()).status).toBe(404);
      expect((await m.OPTIONS()).status).toBe(404);
    }
  });
});

describe('agent OAuth routes on a portal host', () => {
  beforeEach(() => {
    h.site = site('default', 'send', 'send.smartremit.ai');
  });
  it('RFC 8414 metadata names this host as the issuer; CORS open; cacheable', async () => {
    const res = await (await routes.asMeta()).GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.issuer).toBe('https://send.smartremit.ai');
    expect(json.token_endpoint).toBe('https://send.smartremit.ai/oauth/token');
    expect(json.authorization_response_iss_parameter_supported).toBe(true);
    expect(json.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('both RFC 9728 URLs serve the same document for this host', async () => {
    const a = (await (await routes.prMeta()).GET().then((r) => r.json())) as Record<string, unknown>;
    const b = (await (await routes.prMetaMcp()).GET().then((r) => r.json())) as Record<string, unknown>;
    expect(a).toEqual(b);
    expect(a.resource).toBe('https://send.smartremit.ai/api/mcp');
    expect(a.authorization_servers).toEqual(['https://send.smartremit.ai']);
  });
  it('preflights answer 204 with the CORS headers (no credentials; MCP headers exposed)', async () => {
    for (const name of ['token', 'register', 'revoke', 'asMeta', 'prMeta', 'prMetaMcp'] as const) {
      const res = await (await routes[name]()).OPTIONS();
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
});

// TGFL custom host (design D7): the issuer, endpoints, consent Origin and token resource all follow
// PortalSite.host, never a host rebuilt from the slug.
describe('agent OAuth routes on the custom skin host', () => {
  const CUSTOM = 'https://smartremitai.tgfl.org';
  beforeEach(() => {
    h.site = site('default', 'tgfl', 'smartremitai.tgfl.org');
  });
  it('agentHostCtx carries PortalSite.host', async () => {
    const { agentHostCtx } = await import('@/lib/agent-auth/routes');
    expect(await agentHostCtx()).toEqual({ partnerId: 'default', host: 'smartremitai.tgfl.org' });
  });
  it('metadata names the custom host as issuer, endpoints and MCP resource', async () => {
    const as = (await (await routes.asMeta()).GET().then((r) => r.json())) as Record<string, unknown>;
    expect(as.issuer).toBe(CUSTOM);
    expect(as.authorization_endpoint).toBe(`${CUSTOM}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${CUSTOM}/oauth/token`);
    expect(as.registration_endpoint).toBe(`${CUSTOM}/oauth/register`);
    expect(as.revocation_endpoint).toBe(`${CUSTOM}/oauth/revoke`);
    const pr = (await (await routes.prMeta()).GET().then((r) => r.json())) as Record<string, unknown>;
    expect(pr.resource).toBe(`${CUSTOM}/api/mcp`);
    expect(pr.authorization_servers).toEqual([CUSTOM]);
  });
  const consent = (origin: string) =>
    new Request(`${CUSTOM}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: 'decision=allow',
    });
  it('the consent POST from the custom origin passes the Origin check (then fails on the missing ticket)', async () => {
    const res = await (await routes.authorize()).POST(consent(CUSTOM));
    expect(res.status).toBe(400);
  });
  it.each(['https://tgfl.smartremit.ai', 'https://send.smartremit.ai', 'https://tgfl.org'])('the consent POST from %s → 403', async (origin) => {
    const res = await (await routes.authorize()).POST(consent(origin));
    expect(res.status).toBe(403);
  });
  const token = (resource: string) =>
    new Request(`${CUSTOM}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: `agc_${'a'.repeat(22)}`, resource }).toString(),
    });
  it.each(['https://tgfl.smartremit.ai/api/mcp', 'https://send.smartremit.ai/api/mcp'])('the token endpoint refuses resource %s', async (resource) => {
    const res = await (await routes.token()).POST(token(resource));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_target', error_description: `resource must be ${CUSTOM}/api/mcp.` });
  });
  it('the token endpoint accepts the custom resource past the target check', async () => {
    const res = await (await routes.token()).POST(token(`${CUSTOM}/api/mcp`));
    // Past invalid_target: the missing code is the next refusal.
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });
});
