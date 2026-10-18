import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCsp } from '@/lib/csp';

// Stage C1: the route handlers under src/app/oauth/** and src/app/.well-known/**. Each one
// resolves the tenant from the host (getPortalSite) and answers 404 off a live portal host (the
// apex, a preview, the portal off), like /portal/*. Metadata is served on a live host whatever
// the agent.tools switch says (discovery keeps working). The authorize 404 still carries a CSP,
// because next.config.ts leaves that one path out of the site CSP header.

const h = vi.hoisted(() => ({ site: null as null | { partnerId: string; slug: string } }));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));

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
    h.site = { partnerId: 'default', slug: 'send' };
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
