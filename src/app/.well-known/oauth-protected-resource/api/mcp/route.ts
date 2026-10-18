import { protectedResourceMetadata } from '@/lib/agent-auth/config';
import { metadataJson, notServed, preflight } from '@/lib/agent-auth/http';
import { agentHostCtx } from '@/lib/agent-auth/routes';

// GET /.well-known/oauth-protected-resource/api/mcp — RFC 9728 path-suffixed metadata of the MCP
// resource https://<host>/api/mcp (Stage C1). The 401 from /api/mcp points here. The same
// document and rules as /.well-known/oauth-protected-resource. 404 on the apex.

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const ctx = await agentHostCtx();
  return ctx ? metadataJson(protectedResourceMetadata(ctx.host)) : notServed();
}

export async function OPTIONS(): Promise<Response> {
  return (await agentHostCtx()) ? preflight() : notServed();
}
