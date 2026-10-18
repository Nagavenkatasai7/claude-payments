import { handleRegister } from '@/lib/agent-auth/server';
import { notServed, preflight } from '@/lib/agent-auth/http';
import { agentHostCtx, agentServerDeps } from '@/lib/agent-auth/routes';

// POST /oauth/register — RFC 7591 dynamic client registration for AI apps (Stage C1). Portal
// hosts only (404 elsewhere); the client is bound to the host's tenant. 10/hour per IP.

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const ctx = await agentHostCtx();
  if (!ctx) return notServed();
  return handleRegister(req, ctx, agentServerDeps());
}

export async function OPTIONS(): Promise<Response> {
  return (await agentHostCtx()) ? preflight() : notServed();
}
