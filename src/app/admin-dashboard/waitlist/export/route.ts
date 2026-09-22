export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';
import { waitlistCsv } from '@/lib/waitlist';

// POST /admin-dashboard/waitlist/export — the ONE decrypting read of the
// waitlist, and a side effect (an audit row), so it is a POST and never a GET:
// a GET here is a 404 with no export and no audit. Self-gated (a route handler
// is a public endpoint):
//   • a session is required (anonymous ⇒ /login, as every /admin-dashboard page),
//   • only a PLATFORM ADMIN may export — partner-scoped staff and platform
//     agents get the same 404 the page gives (never a 403 that confirms the
//     resource),
//   • CSRF: the request must be SAME-ORIGIN. This mirrors the check Next.js
//     applies to every server action (node_modules/next/dist/server/app-render/
//     action-handler.js:438-461: `origin` host must equal `x-forwarded-host`,
//     else `host`) — the app's mutating routes are server actions, so this is
//     the same rule — except that a MISSING origin fails CLOSED here (Next only
//     warns): a browser form POST always sends Origin, and nothing else should
//     be exporting PII.
// Every export writes an append-only `waitlist.export` audit row carrying the
// row count and the actor — never a name, email or phone.

const NOT_FOUND = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

/** Same-origin check: `origin`'s host must equal `x-forwarded-host` (proxied) or `host`. */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = headers.get('x-forwarded-host')?.split(',')[0].trim() || headers.get('host') || '';
  return host !== '' && originHost.toLowerCase() === host.toLowerCase();
}

export async function GET(): Promise<Response> {
  return NOT_FOUND();
}

export async function POST(req: NextRequest): Promise<Response> {
  const staff = await requireStaff(); // anonymous ⇒ redirect('/login') (307 from a route handler)
  if (staff.role !== 'admin' || staff.partnerId !== undefined) return NOT_FOUND();
  if (!isSameOrigin(req.headers)) {
    return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  }

  const db = getDb();
  const rows = await createWaitlistRepo(db).listDecrypted();
  await createAuditRepo(db).record({
    actor: staff.username,
    actorType: 'staff',
    action: 'waitlist.export',
    meta: { rowCount: rows.length },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(waitlistCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="waitlist-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
