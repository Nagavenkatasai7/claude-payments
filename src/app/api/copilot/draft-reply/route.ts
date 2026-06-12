import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '@/lib/auth';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { checkCopilotRateLimit, draftReply } from '@/lib/ticket-ai';

export const dynamic = 'force-dynamic';

// /api/copilot/draft-reply — one suggested customer reply for the panel.
//
// SELF-GATED: the middleware matcher covers /admin-dashboard and /account
// only — /api/copilot gets NO edge gate, so this route enforces the
// requireSupportOrAdmin contract itself (staff session + support|admin role),
// returning JSON statuses instead of the page-shaped redirects. The ticket is
// then re-resolved UNDER THE CALLER'S SCOPE (getOwnedTicket for partner
// staff) before a single byte reaches the model.

export async function POST(req: NextRequest) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 });
  if (staff.role !== 'support' && staff.role !== 'admin') {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const scope = scopeOf(staff);

  // 60 calls/hour per staff member; FAIL-OPEN on limiter errors (a Redis
  // outage must never take the copilot down — same posture as ip-rate-limit).
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

  let ticketId = '';
  try {
    const body = (await req.json()) as { ticketId?: unknown };
    if (typeof body.ticketId === 'string') ticketId = body.ticketId;
  } catch {
    /* malformed body falls through to the 404 below */
  }
  if (!ticketId) return NextResponse.json({ ok: false }, { status: 404 });

  const repo = createTicketRepo(getDb());
  const ticket =
    scope.kind === 'partner'
      ? await repo.getOwnedTicket(scope.partnerId, ticketId)
      : await repo.getTicket(ticketId);
  if (!ticket || ticket.kind !== 'customer') {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const messages = await repo.listMessages(ticket.id, { includeInternal: true });

  // Customer context: the linked transfer's MASKED summary (default ledger
  // read — the model never sees a full payout destination).
  let customerContext = '';
  if (ticket.transferId) {
    const t = await createTransferRepo(getDb()).getTransfer(ticket.transferId);
    if (t && canSee(scope, t.partnerId)) {
      customerContext =
        `Linked transfer ${t.id}: status ${t.status}, ` +
        `${t.amountSource} ${t.sourceCurrency} to ${t.recipientName} (${t.payoutDestination}), ` +
        `created ${t.createdAt}`;
    }
  }

  try {
    const draft = await draftReply(ticket, messages, customerContext);
    await createAuditRepo(getDb()).record({
      partnerId: ticket.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'copilot.draft',
      subjectId: ticket.id,
    });
    return NextResponse.json({ ok: true, draft });
  } catch {
    // Quiet degradation — the panel shows "AI unavailable"; manual work continues.
    return NextResponse.json({ ok: false, error: 'AI unavailable' }, { status: 502 });
  }
}
