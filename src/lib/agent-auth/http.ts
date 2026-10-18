// HTTP helpers of the AI-agent sign-in's public endpoints (Stage C1 spec item 13). PURE.
//
// CORS: /oauth/token, /oauth/register, /oauth/revoke and /.well-known/* answer OPTIONS and send
// `Access-Control-Allow-Origin: *` with NO credentials (browser-based MCP clients call them
// cross-origin; nothing here reads a cookie). Every OAuth JSON response is `no-store`.

export const AGENT_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '600',
};

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** The answer to a CORS preflight. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...AGENT_CORS_HEADERS } });
}

export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...AGENT_CORS_HEADERS, ...NO_STORE, ...extra } });
}

export function oauthError(error: string, description?: string, status = 400, extra: Record<string, string> = {}): Response {
  return oauthJson(description ? { error, error_description: description } : { error }, status, extra);
}

/** A cacheable public metadata document (5 minutes). */
export function metadataJson(body: unknown): Response {
  return Response.json(body, { status: 200, headers: { ...AGENT_CORS_HEADERS, 'Cache-Control': 'public, max-age=300' } });
}

/** A bare 404 for a host that is not a live portal (the apex, a disabled partner, the portal off). */
export function notServed(): Response {
  return new Response(null, { status: 404 });
}

export const MAX_FORM_BYTES = 8 * 1024;

/**
 * Read an application/x-www-form-urlencoded body (at most MAX_FORM_BYTES). null for another type,
 * an oversized body, or any repeated parameter (RFC 6749 §3.2: parameters MUST NOT repeat).
 */
export async function readForm(req: Request): Promise<URLSearchParams | null> {
  const type = (req.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const text = await readCapped(req, MAX_FORM_BYTES);
  if (text === null) return null;
  const sp = new URLSearchParams(text);
  const seen = new Set<string>();
  for (const k of sp.keys()) {
    if (seen.has(k)) return null;
    seen.add(k);
  }
  return sp;
}

/** The body as text, or null when it is larger than `max` bytes. */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return null;
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) return null;
  return new TextDecoder().decode(buf);
}
