import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { getStore } from '@/lib/store';
import { createScopedStore } from '@/lib/scoped-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { checkCopilotRateLimit } from '@/lib/ticket-ai';
import { suggestKycReview } from '@/lib/kyc-review-ai';

export const dynamic = 'force-dynamic';

// /api/copilot/kyc-review — a 5-line case summary + a CLAMPED decision
// suggestion ({suggested_decision, confidence, top_reasons}) for the KYC
// review panel on the customer detail page.
//
// SELF-GATED like the other copilots: /api/copilot has NO middleware cover, so
// the requireSupportOrAdmin contract is enforced inline (JSON statuses, not
// page redirects), then the customer is re-resolved UNDER THE CALLER'S SCOPE
// (createScopedStore.getCustomer applies canSee — partner staff only ever see
// their own tenant; admin gets the plain read) before a byte reaches the model.
//
// SUGGEST-ONLY: this route NEVER mutates KYC state. The human reviewer still
// types a reason and clicks Approve/Reject through reviewKycAction → the audited
// kyc-case-store.review() path — the human-review-only invariant is untouched.

export async function POST(req: NextRequest) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });
  if (staff.role !== 'support' && staff.role !== 'admin') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // 60 calls/hour per staff member; FAIL-OPEN on limiter errors (a Redis
  // outage must never take the copilot down — same posture as the others).
  try {
    const allowed = await checkCopilotRateLimit(getRedis(), staff.username);
    if (!allowed) {
      return NextResponse.json(
        { ok: false, error: 'Copilot rate limit reached — try again later.' },
        { status: 429 },
      );
    }
  } catch {
    /* fail-open */
  }

  // subjectId is the customer phone. The panel sends {subjectId}.
  let phone = '';
  try {
    const body = (await req.json()) as { subjectId?: unknown };
    if (typeof body.subjectId === 'string') phone = body.subjectId;
  } catch {
    /* malformed body falls through to the 404 below */
  }
  if (!phone) return NextResponse.json({ ok: false }, { status: 404 });

  // Re-resolve the customer under the caller's scope — the SAME read the detail
  // page uses (already returns decrypted PII; no new trust boundary). A partner
  // staffer who can't see this customer gets the 404, never a 403.
  const store = getStore();
  const scoped = createScopedStore(staff);
  const customer = await scoped.getCustomer(phone);
  if (!customer) return NextResponse.json({ ok: false }, { status: 404 });

  // Non-critical audit trail: degrade to an empty trail on transport failure,
  // exactly as the page does — a store hiccup must not 502 the copilot.
  const audit = await getKycCaseStore(store)
    .getAudit(phone)
    .catch(() => [] as Awaited<ReturnType<ReturnType<typeof getKycCaseStore>['getAudit']>>);

  try {
    const suggestion = await suggestKycReview(customer, audit);
    await createAuditRepo(getDb()).record({
      partnerId: customer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'copilot.kyc_review',
      subjectId: customer.senderPhone,
    });
    return NextResponse.json({ ok: true, suggestion });
  } catch {
    // Quiet degradation — the panel shows "AI unavailable"; review continues.
    return NextResponse.json({ ok: false, error: 'AI unavailable' }, { status: 502 });
  }
}
