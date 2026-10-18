import { handleToken } from '@/lib/agent-auth/server';
import { notServed, preflight } from '@/lib/agent-auth/http';
import { agentHostCtx, agentServerDeps } from '@/lib/agent-auth/routes';

// POST /oauth/token — the AI-agent token endpoint (Stage C1): authorization_code with PKCE S256
// and refresh_token with rotation. Portal hosts only (404 elsewhere); the tenant is the host's.
// CORS-open without credentials; the rules live in src/lib/agent-auth/server.ts.

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const ctx = await agentHostCtx();
  if (!ctx) return notServed();
  return handleToken(req, ctx, agentServerDeps());
}

export async function OPTIONS(): Promise<Response> {
  return (await agentHostCtx()) ? preflight() : notServed();
}
