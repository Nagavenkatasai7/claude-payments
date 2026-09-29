import { NextRequest, NextResponse } from 'next/server';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { parseSiteHost } from '@/lib/site-host';
import {
  forwardTarget,
  isSameOriginRequest,
  parseTryItRequest,
  TRY_IT_INVALID,
  TRY_IT_IP_LIMIT,
  TRY_IT_MAX_BODY_BYTES,
  TRY_IT_RATE_SCOPE,
  type TryItOperation,
} from '@/lib/docs/try-it';
import { GET as corridorsGET } from '@/app/api/partner/v1/corridors/route';
import { POST as quotePOST } from '@/app/api/partner/v1/quote/route';
import { POST as validatePOST } from '@/app/api/partner/v1/beneficiaries/validate/route';
import { GET as transactionsGET } from '@/app/api/partner/v1/transactions/route';
import { GET as transactionGET } from '@/app/api/partner/v1/transactions/[id]/route';

// POST /api/docs/try-it: the docs "Try it" proxy (UI redesign M4 PR-5, SPEC §4).
//
// Same origin only; sandbox (sr_test_) keys only, refused BEFORE any key-bearing lookup; a closed
// operation set dispatched IN-PROCESS to the unchanged Partner API handlers (imported read-only:
// the partner-api component is not modified), so guardPartner still authenticates the key, derives
// the tenant from it, applies its scopes and the per-key limit. No outbound fetch (no SSRF).
//
// The key is never logged, stored, echoed or put in an error: every failure returns a fixed
// string, and everything around the key-bearing code is caught and never rethrown, so no error
// (whose message could carry the key) reaches onRequestError (src/instrumentation.ts). Only the
// upstream status, its retry-after and its JSON body come back; no upstream header is passed on.
//
// Apex only: the proxy already 404s /api/docs/try-it on any partner subdomain (src/lib/site-routes.ts,
// tests/proxy-site.test.ts); the host check below is defence in depth.
// Route handlers are uncached by default, and POST is never cached
// (node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md:51).

const NO_STORE = { 'cache-control': 'no-store' };
const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });

type Handler = (req: NextRequest, id: string | undefined) => Promise<Response>;
const HANDLERS: Record<TryItOperation, Handler> = {
  listCorridors: (r) => corridorsGET(r),
  createQuote: (r) => quotePOST(r),
  validateBeneficiary: (r) => validatePOST(r),
  listTransactions: (r) => transactionsGET(r),
  getTransaction: (r, id) => transactionGET(r, { params: Promise.resolve({ id: id ?? '' }) }),
};

class TooLarge extends Error {}

/** Read the body as UTF-8, aborting as soon as it exceeds the byte cap (a missing or lying content-length cannot bypass it). */
async function readCapped(req: NextRequest, cap: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

export async function POST(req: NextRequest) {
  try {
    if (parseSiteHost(req.headers.get('host')).kind !== 'apex') return fail(404, 'Not found.');
    if (!isSameOriginRequest(req.headers, req.nextUrl.origin)) return fail(403, 'Forbidden.');
    const limited = await enforceIpRateLimit(req, TRY_IT_RATE_SCOPE, TRY_IT_IP_LIMIT); // fail-open, src/lib/ip-rate-limit.ts
    if (limited) return limited;
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > TRY_IT_MAX_BODY_BYTES) return fail(413, 'Request too large.');

    let raw: string;
    try {
      raw = await readCapped(req, TRY_IT_MAX_BODY_BYTES);
    } catch (e) {
      return e instanceof TooLarge ? fail(413, 'Request too large.') : fail(400, TRY_IT_INVALID);
    }
    const parsed = parseTryItRequest(req.headers.get('content-type'), raw);
    if (!parsed.ok) return fail(parsed.status, parsed.error);

    const t = forwardTarget(parsed);
    const url = new URL(t.path + t.search, req.nextUrl.origin);
    // A fresh request: ONLY authorization (+ content-type for a body). No client header (cookie,
    // x-forwarded-*, idempotency-key, a second authorization) reaches the handler.
    const fwd = new NextRequest(url, {
      method: t.method,
      headers: { authorization: `Bearer ${parsed.key}`, ...(t.hasBody ? { 'content-type': 'application/json' } : {}) },
      ...(t.hasBody ? { body: JSON.stringify(parsed.body) } : {}),
    });
    const res = await HANDLERS[parsed.op](fwd, parsed.id);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return NextResponse.json({ upstreamStatus: res.status, retryAfter: res.headers.get('retry-after'), body }, { status: 200, headers: NO_STORE });
  } catch {
    return fail(502, 'Try it is unavailable right now.'); // never the error, never the key
  }
}
