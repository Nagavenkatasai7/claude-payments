import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { scopeOf } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { checkCopilotRateLimit } from '@/lib/ticket-ai';
import { suggestDisposition } from '@/lib/review-triage-ai';

export const dynamic = 'force-dynamic';

// /api/copilot/review-triage — a suggested disposition for ONE in-review hold
// on the compliance page (U6).
//
// SELF-GATED like the other /api/copilot routes: the middleware matcher covers
// /admin-dashboard and /account only, so this route enforces the
// requireSupportOrAdmin contract itself (staff session + support|admin role),
// returning JSON statuses instead of page-shaped redirects. The transfer is
// re-resolved UNDER THE CALLER'S SCOPE (getOwnedTransfer for partner staff) —
// the MASKED default ledger read — before a single byte reaches the model.
// SUGGEST-ONLY: release/reject stay the existing audited dashboard-ops actions.

export async function POST(req: NextRequest) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });
  if (staff.role !== 'support' && staff.role !== 'admin') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const scope = scopeOf(staff);

  // Shared 60/h per-staff budget; FAIL-OPEN on limiter errors (a Redis outage
  // must never take the copilot down — same posture as ip-rate-limit).
  try {
    if (!(await checkCopilotRateLimit(getRedis(), staff.username))) {
      return NextResponse.json(
        { ok: false, error: 'Copilot rate limit reached — try again later.' },
        { status: 429 },
      );
    }
  } catch {
    /* fail-open */
  }

  let subjectId = '';
  try {
    const body = (await req.json()) as { subjectId?: unknown };
    if (typeof body.subjectId === 'string') subjectId = body.subjectId;
  } catch {
    /* malformed body falls through to the 404 below */
  }
  if (!subjectId) return NextResponse.json({ ok: false }, { status: 404 });

  // Scope re-resolve: partner staff get the OWNED transfer (404-never-403);
  // platform staff the plain read. Both are MASKED default reads.
  const repo = createTransferRepo(getDb());
  const transfer =
    scope.kind === 'partner'
      ? await repo.getOwnedTransfer(scope.partnerId, subjectId)
      : await repo.getTransfer(subjectId);
  if (!transfer || transfer.status !== 'in_review') {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  try {
    const suggestion = await suggestDisposition(transfer);
    await createAuditRepo(getDb()).record({
      partnerId: transfer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'copilot.review_triage',
      subjectId,
      meta: { urgency: suggestion.urgency, suggested_path: suggestion.suggested_path },
    });
    return NextResponse.json({ ok: true, suggestion });
  } catch {
    // Quiet degradation — the panel shows "AI unavailable"; manual triage continues.
    return NextResponse.json({ ok: false, error: 'AI unavailable' }, { status: 502 });
  }
}
