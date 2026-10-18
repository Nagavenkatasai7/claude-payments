import type { NextRequest } from 'next/server';
import { getAgentAuth } from '@/lib/agent-auth';
import { getPortalSite } from '@/lib/portal-site';
import { getRedis } from '@/lib/redis';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { handleMcpRequest, type McpHttpDeps } from '@/lib/mcp/http';

// /api/mcp — SmartRemit's MCP server for AI apps (Stage C1): Streamable HTTP, stateless, read-only
// tools for one signed-in customer. Served ONLY on customer-portal hosts (getPortalSite: the tenant is
// a function of the Host, through the proxy-set site header that getSiteTenant re-verifies); the apex
// and every other host get a bare 404. Every request carries a bearer token from the Authorization
// header; the token's tenant must be this host's. See src/lib/mcp/http.ts for the order of checks.
//
// Route handlers are never cached for POST/DELETE/OPTIONS, and GET reads the request headers here
// (node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md:43,51); defining
// OPTIONS replaces Next's automatic one (…/03-api-reference/03-file-conventions/route.md:39).

/** Per-IP requests a minute: the blunt outer ring (fail open); the per-grant tool limits are inside. */
export const MCP_IP_LIMIT = 300;

function deps(req: NextRequest): McpHttpDeps {
  return {
    site: getPortalSite,
    auth: getAgentAuth(),
    redis: getRedis(),
    ipLimit: () => enforceIpRateLimit(req, 'mcp', MCP_IP_LIMIT),
  };
}

const serve = (req: NextRequest) => handleMcpRequest(req, deps(req));

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
export const OPTIONS = serve;
