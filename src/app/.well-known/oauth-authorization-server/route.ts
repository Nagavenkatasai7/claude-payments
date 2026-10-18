import { authorizationServerMetadata } from '@/lib/agent-auth/config';
import { metadataJson, notServed, preflight } from '@/lib/agent-auth/http';
import { agentHostCtx } from '@/lib/agent-auth/routes';

// GET /.well-known/oauth-authorization-server — RFC 8414 metadata of this portal host's AI-agent
// authorization server (Stage C1). Served while the portal is live on the host, whatever the
// agent.tools switch says, so an app can discover the server and show the "switched off" answer.
// Not OIDC: there is no /.well-known/openid-configuration. 404 on the apex.

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const ctx = await agentHostCtx();
  return ctx ? metadataJson(authorizationServerMetadata(ctx.host)) : notServed();
}

export async function OPTIONS(): Promise<Response> {
  return (await agentHostCtx()) ? preflight() : notServed();
}
