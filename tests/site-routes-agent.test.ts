import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { classifySitePath } from '@/lib/site-routes';
const { resolveSiteSlug } = vi.hoisted(() => ({ resolveSiteSlug: vi.fn() }));
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug }));
import { proxy } from '@/proxy';

// Stage C1: the AI-agent sign-in and the MCP endpoint serve on portal (subdomain) hosts at EXACT
// paths only. On the apex the proxy never vouches for a tenant, so the route handlers (which
// resolve getPortalSite() themselves) answer 404 there (tests/agent-oauth-routes.test.ts).

const AGENT_PATHS = [
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/api/mcp',
  '/api/mcp',
];

describe('classifySitePath (agent paths)', () => {
  it.each(AGENT_PATHS)('%s → allow on a subdomain', (p) => expect(classifySitePath(p)).toEqual({ kind: 'allow' }));
  it.each([
    '/oauth',
    '/oauth/authorize/x',
    '/oauth/tokens',
    '/oauth/token/',
    '/oauth/x',
    '/OAuth/authorize',
    '/api/mcp/x',
    '/api/mcpx',
    '/api/mcp/',
    '/.well-known',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-protected-resource/x',
    '/.well-known/oauth-authorization-server/x',
    '/.well-known/security.txt',
  ])('%s → deny (exact paths only)', (p) => expect(classifySitePath(p)).toEqual({ kind: 'deny' }));
});

describe('the proxy on agent paths', () => {
  beforeAll(() => vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1'));
  afterAll(() => vi.unstubAllEnvs());
  const req = (host: string, path: string, method = 'GET') => new NextRequest(`https://${host}${path}`, { method, headers: { host } });

  it.each(AGENT_PATHS)('%s on a live partner host passes with the tenant headers', async (p) => {
    resolveSiteSlug.mockResolvedValue('default');
    const r = await proxy(req('send.smartremit.ai', p, p === '/oauth/token' ? 'POST' : 'GET'));
    expect(r.headers.get('x-middleware-next')).toBe('1');
    expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBe('default');
    expect(r.headers.get('x-middleware-request-x-sr-site-slug')).toBe('send');
  });
  it('a sub-path is refused on a partner host', async () => {
    resolveSiteSlug.mockResolvedValue('default');
    const r = await proxy(req('send.smartremit.ai', '/oauth/token/x', 'POST'));
    expect(r.status).toBe(404);
  });
  it('on the apex the proxy sets no tenant (the route itself answers 404)', async () => {
    resolveSiteSlug.mockClear();
    const r = await proxy(req('smartremit.ai', '/oauth/authorize'));
    expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBeNull();
    expect(resolveSiteSlug).not.toHaveBeenCalled();
  });
  it('with the portal switched off no agent path serves on a partner host', async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '0');
    try {
      resolveSiteSlug.mockResolvedValue('default');
      const r = await proxy(req('send.smartremit.ai', '/oauth/token', 'POST'));
      expect(r.status).toBe(404);
    } finally {
      vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1');
    }
  });
});
