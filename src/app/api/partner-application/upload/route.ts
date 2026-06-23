import { NextResponse, type NextRequest } from 'next/server';
import { uploadPartnerDoc } from '@/lib/blob';
import { clientIpFrom, checkIpRateLimit } from '@/lib/ip-rate-limit';
import { hashApplicationToken, isApplicationTokenExpired } from '@/lib/partner-application-token';
import { getRedis } from '@/lib/redis';
import { getStore } from '@/lib/store';

// POST /api/partner-application/upload?token=<token>
// One-document-at-a-time upload for the detailed partner application. PUBLIC but
// token-gated: the URL token is the capability — re-hash it, resolve the
// partner_request, and refuse a missing/expired/completed link (404). The token
// is validated identically by the page and the submit action; nothing here is
// trusted beyond it. Content-type and size are checked SERVER-SIDE before the
// file ever reaches Blob. Uploads degrade gracefully: an unconfigured Blob store
// returns a clear 503 so the form can still submit without attachments.

export const runtime = 'nodejs';

const MAX_BYTES = Math.floor(4.5 * 1024 * 1024); // 4.5 MB
const ALLOWED_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

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
    request.applicationStatus === 'completed'
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
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: 'Unsupported file type — upload a PDF, PNG, or JPEG.' },
      { status: 400 },
    );
  }

  const label = String(formData.get('label') ?? 'Document').trim().slice(0, 100) || 'Document';
  const rawName =
    file instanceof File && file.name ? file.name : 'document';
  // Sanitise the filename to a flat, safe segment (no path traversal into Blob).
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'document';
  const filename = `${token.slice(0, 8)}-${Date.now()}-${safeName}`;

  // ── UPLOAD — friendly 503 when Blob isn't configured (form still submits). ──
  try {
    const doc = await uploadPartnerDoc(file, filename);
    return NextResponse.json({
      ok: true,
      doc: { label, url: doc.url, size: doc.size, contentType: doc.contentType },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('not configured')) {
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
