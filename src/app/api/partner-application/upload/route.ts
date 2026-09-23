import { NextResponse, type NextRequest } from 'next/server';
import { isBlobNotConfigured, isPartnerDocType, sniffDocType, uploadPartnerDoc } from '@/lib/blob';
import { clientIpFrom, checkIpRateLimit } from '@/lib/ip-rate-limit';
import { hashApplicationToken, isApplicationTokenExpired } from '@/lib/partner-application-token';
import { getRedis } from '@/lib/redis';
import { getStore } from '@/lib/store';

// POST /api/partner-application/upload?token=<token>
// One-document-at-a-time upload for the detailed partner application. PUBLIC but
// token-gated: the URL token is the capability — re-hash it, resolve the
// partner_request, and refuse a missing/expired link or any row not 'invited' (404). The token
// is validated identically by the page and the submit action; nothing here is
// trusted beyond it. Size, declared type AND the leading bytes (magic-number
// sniff, fix 24) are checked SERVER-SIDE before the file ever reaches Blob; the
// stored contentType is the sniffed one. The object lands in the PRIVATE store
// under `partner-applications/<requestId>/…` (the request the token resolved —
// the submit action accepts a ref only under that prefix). Uploads degrade
// gracefully: an unconfigured private store returns a clear 503 so the form can
// still submit without attachments.

export const runtime = 'nodejs';

const MAX_BYTES = Math.floor(4.5 * 1024 * 1024); // 4.5 MB
const SNIFF_BYTES = 8;

export async function POST(req: NextRequest) {
  // ── IDENTITY — the token is the only trusted input. Re-validate. ──
  const token = req.nextUrl.searchParams.get('token')?.trim() ?? '';
  if (!token) {
    return NextResponse.json({ error: 'Invalid or expired application link.' }, { status: 404 });
  }
  const request = await getStore().getPartnerRequestByTokenHash(hashApplicationToken(token));
  if (
    !request ||
    isApplicationTokenExpired(request.tokenExpiresAt) ||
    request.applicationStatus !== 'invited' // refuse unless invited (fix 49C: decided links stay dead)
  ) {
    return NextResponse.json({ error: 'Invalid or expired application link.' }, { status: 404 });
  }

  // ── RATE LIMIT — blunt per-IP outer ring; fail-open on any limiter error. ──
  try {
    const r = await checkIpRateLimit(
      getRedis(),
      'partner-application-upload',
      clientIpFrom(req.headers),
      { limit: 20, windowSec: 3600 },
    );
    if (!r.allowed) {
      return NextResponse.json(
        { error: 'Too many uploads — please retry in a minute.' },
        { status: 429, headers: { 'retry-after': '3600' } },
      );
    }
  } catch {
    // fail-open — availability wins; a limiter outage must not block uploads.
  }

  // ── READ + VALIDATE the file (server-side, authoritative) ─────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid upload.' }, { status: 400 });
  }
  const file = formData.get('file');
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File is too large (max 4.5 MB).' }, { status: 400 });
  }
  const unsupported = () =>
    NextResponse.json(
      { error: 'Unsupported file type — upload a PDF, PNG, or JPEG.' },
      { status: 400 },
    );
  if (!isPartnerDocType(file.type)) return unsupported();
  // The declared type is a client claim; the leading bytes must agree with it.
  // A PNG renamed to .pdf (or HTML declared as an image) is refused here and
  // never reaches the store.
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const sniffed = sniffDocType(head);
  if (sniffed === null || sniffed !== file.type) return unsupported();

  const label = String(formData.get('label') ?? 'Document').trim().slice(0, 100) || 'Document';
  const rawName =
    file instanceof File && file.name ? file.name : 'document';
  // Sanitise the filename to a flat, safe segment (no path traversal into Blob).
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'document';
  // Request-scoped key: the submit action binds refs to this prefix. No token
  // characters in the pathname (fix 24).
  const pathname = `partner-applications/${request.id}/${Date.now()}-${safeName}`;

  // ── UPLOAD — friendly 503 when the private store isn't configured. ──────────
  try {
    const doc = await uploadPartnerDoc(file, pathname, sniffed);
    return NextResponse.json({
      ok: true,
      doc: { label, url: doc.url, size: doc.size, contentType: doc.contentType },
    });
  } catch (err) {
    if (isBlobNotConfigured(err)) {
      return NextResponse.json(
        {
          error:
            'Document uploads are not enabled yet — you can submit the form without attachments.',
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 });
  }
}
