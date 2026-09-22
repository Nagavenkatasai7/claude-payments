import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { requireScope } from '@/lib/auth';
import {
  isBlobNotConfigured,
  isOwnPrivateStoreRef,
  isPartnerDocType,
  isPrivatePartnerDocRef,
  streamPartnerDoc,
} from '@/lib/blob';
import { env } from '@/lib/env';
import { logError } from '@/lib/log';
import { getStore } from '@/lib/store';

// GET /admin-dashboard/partner-requests/[id]/documents/[index] — the ONLY staff
// read path for a partner's licence / KYB / AML documents (Program-Fix 24).
//
// The route is PUBLIC-facing like every handler under the app, so it self-gates:
//   1. requireScope() (support ⇒ redirected there; no session ⇒ /login), then
//      404 unless the scope is PLATFORM. 404-never-403: a partner-scoped staffer
//      never learns an application exists, and nothing is audited for them.
//   2. The document is resolved from the LEDGER by (requestId, index) — never
//      from a client-supplied URL or pathname — and the ref must still bind to
//      this request (isPrivatePartnerDocRef) before the store is asked for it.
//      A legacy public-host ref (not yet re-issued by the owner script) is 404,
//      never proxied.
//   3. One audit_events row (`partner_doc.view`) is written BEFORE any bytes.
//      If that write fails, the response is 500 and the store is never called.
//   4. The body streams straight through (`new Response(stream)`, Next
//      route.md "Streaming"), with `Cache-Control: private, no-store`,
//      `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and
//      the store's recorded (sniffed) content type, allow-listed. No label or
//      URL ever reaches a header; the CDN caches nothing.
// The /admin-dashboard/:path* middleware matcher (src/middleware.ts) is the
// outer ring; the security headers in next.config.ts apply to /:path*.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const notFound = () => new NextResponse(null, { status: 404 });

/** A canonical non-negative integer string: '0', '12' — never '01', '-1', '1e0', ' 0'. */
function parseIndex(raw: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  // 1. Self-gate. Only PLATFORM staff may read partner documents.
  const { staff, scope } = await requireScope();
  if (scope.kind !== 'platform') return notFound();

  // 2. Resolve from the ledger by (requestId, index).
  const { id, index: rawIndex } = await params;
  const index = parseIndex(rawIndex);
  if (index === null) return notFound();
  const store = getStore();
  const request = await store.getPartnerRequest(id);
  if (!request) return notFound();
  const application = await store.getPartnerApplicationByRequestId(id);
  if (!application) return notFound();
  const doc = application.documents[index];
  if (!doc) return notFound();
  // The ledger value was client-submitted (through the bound submit action), so
  // it is re-bound here: the private-store domain + this request's prefix, AND
  // exactly the store our token opens (isOwnPrivateStoreRef). Anything else —
  // a legacy public ref, another request's object, a foreign host, someone
  // else's private store — is 404 and the store (and our token) never sees it.
  // With no private token there is no store to pin to and nothing can be read:
  // 503 (the same "not enabled" the upload gives), before any audit row.
  if (!isPrivatePartnerDocRef(doc.url, id)) return notFound();
  if (!env.partnerDocsBlobToken) return new NextResponse(null, { status: 503 });
  if (!isOwnPrivateStoreRef(doc.url)) return notFound();

  // 3. Audit BEFORE any bytes. A failed audit write ⇒ 500, no read.
  try {
    await createAuditRepo(getDb()).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'partner_doc.view',
      subjectId: application.id,
      meta: { requestId: id, index },
    });
  } catch (err) {
    logError('partner-docs', 'audit write failed; document not served', { requestId: id, index, err });
    return new NextResponse(null, { status: 500 });
  }

  // 4. Stream from the private store.
  let obj: Awaited<ReturnType<typeof streamPartnerDoc>>;
  try {
    obj = await streamPartnerDoc(doc.url);
  } catch (err) {
    if (isBlobNotConfigured(err)) return new NextResponse(null, { status: 503 });
    logError('partner-docs', 'private store read failed', { requestId: id, index, err });
    return new NextResponse(null, { status: 502 });
  }
  if (!obj) return notFound();

  const contentType = isPartnerDocType(obj.contentType) ? obj.contentType : 'application/octet-stream';
  const ext = EXT[contentType] ?? 'bin';
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="document-${index}.${ext}"`,
  });
  // No content-length: the SDK derives `size` from the upstream content-length
  // (dist/index.js:184,199), which need not equal the decoded stream's length.
  return new NextResponse(obj.stream, { status: 200, headers });
}
