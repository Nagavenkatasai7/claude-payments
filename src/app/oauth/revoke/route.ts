import { handleRevoke } from '@/lib/agent-auth/server';
import { notServed, preflight } from '@/lib/agent-auth/http';
import { agentHostCtx, agentServerDeps } from '@/lib/agent-auth/routes';

// POST /oauth/revoke — RFC 7009 token revocation for AI apps (Stage C1). Portal hosts only.

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const ctx = await agentHostCtx();
  if (!ctx) return notServed();
  return handleRevoke(req, ctx, agentServerDeps());
}

export async function OPTIONS(): Promise<Response> {
  return (await agentHostCtx()) ? preflight() : notServed();
}
