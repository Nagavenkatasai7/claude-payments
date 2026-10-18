import { buildCsp } from '@/lib/csp';
import { handleAuthorizeGet, handleAuthorizePost } from '@/lib/agent-auth/authorize-flow';
import { agentHostCtx, authorizeDeps } from '@/lib/agent-auth/routes';

// /oauth/authorize — the customer-facing AI-agent sign-in (Stage C1): GET validates and shows the
// consent screen (after the portal sign-in and step-up), POST is Allow / Deny. A ROUTE HANDLER,
// not a page, so it owns every response header: next.config.ts leaves exactly this path out of
// the site CSP header and every response here sends its own (src/lib/agent-auth/authorize-csp.ts),
// the 404 below included. Rules: src/lib/agent-auth/authorize-flow.ts.

export const dynamic = 'force-dynamic';

/** Apex, preview, portal off or not enabled: a 404 that still carries the site CSP. */
function notHere(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'Content-Security-Policy': buildCsp({ isDev: process.env.NODE_ENV === 'development' }), 'Cache-Control': 'no-store' },
  });
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await agentHostCtx();
  if (!ctx) return notHere();
  return handleAuthorizeGet(req, ctx, authorizeDeps());
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await agentHostCtx();
  if (!ctx) return notHere();
  return handleAuthorizePost(req, ctx, authorizeDeps());
}
