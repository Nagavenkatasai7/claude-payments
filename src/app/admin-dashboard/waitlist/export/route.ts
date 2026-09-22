export const dynamic = 'force-dynamic';

import { requireStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';
import { waitlistCsv } from '@/lib/waitlist';

// GET /admin-dashboard/waitlist/export — the ONE decrypting read of the
// waitlist. Self-gated (a route handler is a public GET): a session is required
// (anonymous ⇒ /login, as every /admin-dashboard page), and only a PLATFORM
// ADMIN may export — partner-scoped staff and platform agents get the same 404
// the page gives (never a 403 that confirms the resource). Every export writes
// an append-only `waitlist.export` audit row carrying the row count and the
// actor — never a name, email or phone.

export async function GET(): Promise<Response> {
  const staff = await requireStaff(); // anonymous ⇒ redirect('/login') (307 from a route handler)
  if (staff.role !== 'admin' || staff.partnerId !== undefined) {
    return new Response('Not found', { status: 404 });
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
