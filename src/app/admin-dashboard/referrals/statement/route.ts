export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { requireStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { buildReferralStatement } from '@/lib/referral-admin';
import { referralStatementCsv } from '@/lib/referrals';
import { isSameOrigin } from '@/lib/same-origin';
import { mfaEnrolmentRequired } from '@/lib/staff-mfa-policy';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';

// POST /admin-dashboard/referrals/statement (Batch B4): the monthly referral-commission CSV that
// is loaded into Plum by hand. It writes an audit row, so it is a POST and never a GET (a GET is
// a 404). The same gates as the waitlist export (src/app/admin-dashboard/waitlist/export/route.ts):
// a session, a PLATFORM ADMIN only (anyone else gets the page's 404), and a same-origin request
// (a missing Origin fails closed). The CSV holds only the referral partner's name and contact and
// the amounts: never a customer, phone or transfer.

const NOT_FOUND = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

export async function GET(): Promise<Response> {
  return NOT_FOUND();
}

export async function POST(req: NextRequest): Promise<Response> {
  const staff = await requireStaff(); // anonymous ⇒ redirect('/login')
  if (staff.role !== 'admin' || staff.partnerId !== undefined) return NOT_FOUND();
  // requirePlatformAdmin's MFA rule (src/lib/auth.ts): an unenrolled admin is sent to enrol
  // there; a download route answers 404 instead of a redirect.
  if (mfaEnrolmentRequired(staff) && !(await getStaffMfaStore().isEnrolled(staff.username))) return NOT_FOUND();
  if (!isSameOrigin(req.headers)) {
    return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  let month: unknown = null;
  try {
    month = (await req.formData()).get('month');
  } catch {
    month = null; // no form body ⇒ the current month
  }

  const db = getDb();
  const statement = await buildReferralStatement(db, month, new Date());
  await createAuditRepo(db).record({
    actor: staff.username,
    actorType: 'staff',
    action: 'referral.statement_export',
    subjectId: statement.month,
    meta: { rowCount: statement.lines.length, totalCents: statement.totalCents },
  });

  return new Response(referralStatementCsv(statement.month, statement.lines), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="referral-statement-${statement.month}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
