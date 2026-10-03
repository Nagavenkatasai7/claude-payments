import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { customerPortalOrigin } from '@/lib/customer-portal-url';
import { isIpRateLimited } from '@/lib/ip-rate-limit';
import { parseContinueTarget, portalPathFor, type LegacyLinkTarget } from '@/lib/legacy-deep-link';
import { parseSiteHost } from '@/lib/site-host';
import type { PartnerId } from '@/lib/types';

// GET /account/continue/<kind>/<id> (lost-features C2): the public hand-over for an old /account
// receipt or ticket link opened signed out (the proxy sends it here, src/lib/legacy-deep-link.ts).
//
// It reads ONLY which partner the named row belongs to, and forwards to that partner's live portal
// sign-in with `?next=` the matching portal page; the portal re-checks the session and ownership
// after sign-in. Every other case (malformed id, missing row, test row, internal ticket, no live
// portal, a lookup error, rate limited) is the SAME redirect to /account/login, so the answer says
// nothing about the row beyond "which portal". Apex only; per-IP limited (fail-open, before any
// read). Read-only, no audit (an anonymous redirect).

const LEGACY_LINK_SCOPE = 'legacy-link';
const LEGACY_LINK_IP_LIMIT = 30;
const LEGACY_LINK_WINDOW_SEC = 3600;

const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/** The partner a live receipt or a customer ticket belongs to, or null. */
async function partnerOf(target: LegacyLinkTarget): Promise<PartnerId | null> {
  const db = getDb();
  if (target.kind === 'receipt') {
    const t = await createTransferRepo(db).getTransfer(target.id); // masked: only partnerId is used
    return t && (t.environment ?? 'live') === 'live' ? t.partnerId : null;
  }
  const ticket = await createTicketRepo(db).getTicket(target.id);
  return ticket && ticket.kind === 'customer' ? ticket.partnerId : null;
}

async function portalSignIn(target: LegacyLinkTarget): Promise<string | null> {
  try {
    const partnerId = await partnerOf(target);
    if (!partnerId) return null;
    const origin = await customerPortalOrigin(partnerId);
    return origin ? `${origin}/portal/login?next=${encodeURIComponent(portalPathFor(target))}` : null;
  } catch {
    return null; // fail closed to the legacy sign-in
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }) {
  if (parseSiteHost(req.headers.get('host')).kind !== 'apex') return new NextResponse(null, { status: 404 });
  const fallback = new URL('/account/login', req.url).toString();
  let to = fallback;
  if (!(await isIpRateLimited(req.headers, LEGACY_LINK_SCOPE, LEGACY_LINK_IP_LIMIT, LEGACY_LINK_WINDOW_SEC))) {
    const { kind, id } = await params;
    const target = parseContinueTarget(kind, id);
    if (target) to = (await portalSignIn(target)) ?? fallback;
  }
  const res = NextResponse.redirect(to, 307);
  for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
  return res;
}
