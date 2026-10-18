import { protectedResourceMetadata } from '@/lib/agent-auth/config';
import { metadataJson, notServed, preflight } from '@/lib/agent-auth/http';
import { agentHostCtx } from '@/lib/agent-auth/routes';

// GET /.well-known/oauth-protected-resource — RFC 9728 metadata of this host's MCP endpoint
// (Stage C1). The same JSON as /.well-known/oauth-protected-resource/api/mcp (the URL a 401 from
// /api/mcp names). 404 on the apex.

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const ctx = await agentHostCtx();
  return ctx ? metadataJson(protectedResourceMetadata(ctx.host)) : notServed();
}

export async function OPTIONS(): Promise<Response> {
  return (await agentHostCtx()) ? preflight() : notServed();
}
